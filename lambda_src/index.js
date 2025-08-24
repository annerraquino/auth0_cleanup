// index.js
// Runtime: AWS Lambda, Node.js 20.x (global fetch available)

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParametersByPathCommand, GetParametersCommand } = require("@aws-sdk/client-ssm");

// ---------- Config: SSM Keys we expect ----------
const EXPECTED_KEYS = [
  "S3_BUCKET",
  "S3_KEY",                  // optional; default applied if missing
  "AUTH0_DOMAIN",
  "AUTH0_AUDIENCE",          // optional; auto-derived from domain if missing
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "SSOID"                    // optional; can be overridden by event
];

// Hierarchical prefix (path style). You can override via env PARAM_PREFIX.
const DEFAULT_PARAM_PREFIX = "/auth0-cleanup/";
// Flat prefix fallback for any missing keys.
const FLAT_PREFIX = "auth0_cleanup_";

// ---------- AWS Clients ----------
const s3 = new S3Client({});   // region from AWS_REGION
const ssm = new SSMClient({}); // region from AWS_REGION

// CSV schema (fixed)
const CSV_HEADER = "ssoid,deactivation_flag,last_update_timestamp,user_id,email,name,providers,connections,created_at,last_login,logins_count,deleted_by\n";

// ---------- Lambda Handler ----------
module.exports.handler = async (event = {}, context = {}) => {
  try {
    // 1) Load parameters (once per cold start)
    await loadParamsIntoEnv();

    // 2) Resolve config after SSM is loaded
    const AUTH0_DOMAIN   = mustEnv("AUTH0_DOMAIN");
    const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || `https://${stripProtocol(AUTH0_DOMAIN)}/api/v2/`;
    const S3_BUCKET      = process.env.S3_BUCKET;
    const S3_KEY         = process.env.S3_KEY || "output/deleted_users.csv";

    // 3) Auth0 token
    const token = await getMgmtToken({
      domain: AUTH0_DOMAIN,
      clientId: mustEnv("AUTH0_CLIENT_ID"),
      clientSecret: mustEnv("AUTH0_CLIENT_SECRET"),
      audience: AUTH0_AUDIENCE
    });

    // 4) Determine SSOID (path > query > SSM/env)
    const SSOID = getSsoid(event);

    // 5) Search in Auth0
    let users = await searchUsersByQuery(AUTH0_DOMAIN, token, `identities.user_id:"${SSOID}"`);
    if (users.length === 0) {
      users = await searchUsersByQuery(AUTH0_DOMAIN, token, `app_metadata.ssoid:"${SSOID}"`);
    }

    if (users.length === 0) {
      const message = "Cannot find user";
      console.log(`${message} for SSOID=${SSOID}`);
      return response(200, { message, ssoid: SSOID, results: [] });
    }

    // 6) Delete and build CSV rows
    const results = [];
    const csvRows = [];
    const deletedBy = getDeletedBy(context);

    for (const u of users) {
      const userId = u.user_id;
      try {
        await deleteUser(AUTH0_DOMAIN, token, userId);
        console.log(`Deleted Auth0 user_id=${userId}`);
        results.push({ user_id: userId, deleted: true });

        csvRows.push(buildCsvRow({ ssoid: SSOID, user: u, deletedBy }));
      } catch (err) {
        console.error(`Failed to delete user_id=${userId}:`, err?.message || err);
        results.push({ user_id: userId, deleted: false, error: err?.message || String(err) });
      }
    }

    // 7) Append to S3 if any were deleted
    if (csvRows.length > 0 && S3_BUCKET) {
      try {
        await appendRowsToCsvInS3({ bucket: S3_BUCKET, key: S3_KEY, rows: csvRows });
      } catch (e) {
        console.error("Failed to write deleted_users.csv:", e?.message || e);
      }
    } else if (!S3_BUCKET) {
      console.warn("S3_BUCKET not set; skipping CSV write.");
    }

    return response(200, {
      message: "Delete attempt complete",
      ssoid: SSOID,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("Unhandled error:", err?.message || err);
    return response(500, { error: err?.message || String(err) });
  }
};

// ---------- Parameter Store Loader ----------

let paramsLoaded = false;

async function loadParamsIntoEnv() {
  if (paramsLoaded) return;

  const prefix = (process.env.PARAM_PREFIX || DEFAULT_PARAM_PREFIX).trim();
  const wantPath = prefix.startsWith("/");

  // Try hierarchical first (GetParametersByPath)
  if (wantPath) {
    let nextToken;
    do {
      const resp = await ssm.send(new GetParametersByPathCommand({
        Path: prefix.endsWith("/") ? prefix : (prefix + "/"),
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken
      }));
      for (const p of (resp.Parameters || [])) {
        const key = p.Name.substring(p.Name.lastIndexOf("/") + 1);
        if (EXPECTED_KEYS.includes(key) && !process.env[key]) {
          process.env[key] = p.Value;
        }
      }
      nextToken = resp.NextToken;
    } while (nextToken);
  }

  // Fallback: fetch any still-missing keys by flat names
  const missing = EXPECTED_KEYS.filter(k => !process.env[k]);
  if (missing.length) {
    const flatNames = missing.map(k => FLAT_PREFIX + k);
    const resp = await ssm.send(new GetParametersCommand({
      Names: flatNames,
      WithDecryption: true
    }));
    for (const p of (resp.Parameters || [])) {
      const key = p.Name.replace(FLAT_PREFIX, "");
      if (EXPECTED_KEYS.includes(key) && !process.env[key]) {
        process.env[key] = p.Value;
      }
    }
    if (resp.InvalidParameters && resp.InvalidParameters.length) {
      // Not fatal; just log which ones couldn't be found
      console.warn("Missing SSM params:", resp.InvalidParameters.join(", "));
    }
  }

  paramsLoaded = true;
}

// ---------- Auth0 Helpers ----------

async function getMgmtToken({ domain, clientId, clientSecret, audience }) {
  if (!domain) throw new Error("Missing AUTH0_DOMAIN");
  if (!clientId) throw new Error("Missing AUTH0_CLIENT_ID");
  if (!clientSecret) throw new Error("Missing AUTH0_CLIENT_SECRET");
  if (!audience) throw new Error("Missing AUTH0_AUDIENCE");

  const url = `https://${stripProtocol(domain)}/oauth/token`;
  const body = {
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    audience
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      if (text.includes("access_denied") && text.includes("client-grant")) {
        throw new Error(
          `Access denied to Management API: create a client grant for your M2M app with scopes like read:users, delete:users. Raw: ${text}`
        );
      }
      throw new Error(`Token HTTP ${res.status} ${res.statusText}: ${text}`);
    }

    const data = JSON.parse(text);
    if (!data.access_token) throw new Error("Token response missing access_token");
    return data.access_token;
  } finally {
    clearTimeout(t);
  }
}

async function searchUsersByQuery(domain, token, q) {
  try {
    const url = new URL(`https://${stripProtocol(domain)}/api/v2/users`);
    url.searchParams.set("q", q);
    url.searchParams.set("search_engine", "v3");
    url.searchParams.set("per_page", "50");

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`User search failed HTTP ${res.status}: ${text}`);
    }

    let users = [];
    try {
      users = JSON.parse(text);
    } catch {
      console.error("User search response not JSON:", text);
      return [];
    }

    if (!Array.isArray(users) || users.length === 0) {
      console.log(`Cannot find user with query: ${q}`);
      return [];
    }

    return users;
  } catch (err) {
    console.error(`Error during searchUsersByQuery for query=${q}:`, err?.message || err);
    return [];
  }
}

async function deleteUser(domain, token, userId) {
  const url = `https://${stripProtocol(domain)}/api/v2/users/${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete failed HTTP ${res.status}: ${text}`);
  }
}

// ---------- S3 CSV Helpers ----------

async function appendRowsToCsvInS3({ bucket, key, rows }) {
  let existing = "";
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    existing = await streamToString(obj.Body);
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode;
    if (!(code === 404 || e?.name === "NoSuchKey" || e?.Code === "NoSuchKey")) throw e;
  }

  // Ensure header once
  let nextContent = existing;
  if (!existing || !existing.trimStart().toLowerCase().startsWith(CSV_HEADER.split("\n")[0])) {
    nextContent = CSV_HEADER + (existing && existing.length ? existing.replace(/^\ufeff?/, "") : "");
  }

  nextContent += rows.join("");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: nextContent,
    ContentType: "text/csv",
  }));
}

function buildCsvRow({ ssoid, user, deletedBy }) {
  const now = new Date().toISOString();
  const providers   = (user.identities || []).map(i => i.provider).join(";");
  const connections = (user.identities || []).map(i => i.connection).join(";");

  const fields = [
    ssoid,                  // ssoid
    "Y",                    // deactivation_flag
    now,                    // last_update_timestamp
    user.user_id || "",     // user_id
    user.email || "",       // email
    user.name || user.nickname || user.username || "", // name
    providers,              // providers
    connections,            // connections
    user.created_at || "",  // created_at
    user.last_login || "",  // last_login
    safeNum(user.logins_count), // logins_count
    deletedBy               // deleted_by
  ];
  return fields.map(csvEscape).join(",") + "\n";
}

// ---------- Small Utils ----------

function stripProtocol(domain) {
  return String(domain || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function getSsoid(event) {
  const path = event?.pathParameters?.ssoid;
  const query = event?.queryStringParameters?.ssoid;
  return path || query || process.env.SSOID || "REPLACE_WITH_SSOID";
}

function getDeletedBy(context) {
  return (
    context?.functionName ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.DELETED_BY ||
    "local"
  );
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function safeNum(n) {
  return (typeof n === "number" && Number.isFinite(n)) ? n : "";
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", c => chunks.push(Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

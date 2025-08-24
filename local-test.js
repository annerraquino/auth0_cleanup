// local-test.js
// Runs your Lambda locally, loading config from SSM first (handled inside index.js).

const { handler } = require("./index.js");

(async () => {
  try {
    // SSM prefix & region
    process.env.PARAM_PREFIX = process.env.PARAM_PREFIX || "/auth0-cleanup/";
    process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";

    // <<< Set your SSOID here for local runs >>>
    process.env.SSOID = process.env.SSOID || "68a78b7bfa1806316506bd29";

    // If you prefer to override via the event instead, uncomment ONE of these:
    const event = {
      // pathParameters: { ssoid: process.env.SSOID },
      // queryStringParameters: { ssoid: process.env.SSOID },
    };

    const context = { functionName: "local-auth0-cleanup" };

    const res = await handler(event, context);
    console.log("Status:", res.statusCode);
    try {
      console.log("Body:", JSON.stringify(JSON.parse(res.body), null, 2));
    } catch {
      console.log("Body:", res.body);
    }
  } catch (err) {
    console.error("Test error:", err);
    process.exitCode = 1;
  }
})();

locals {
  lambda_src_dir = "${path.module}/../lambda_src"
  # Where the zipped bundle will be written during plan/apply (runner workspace)
  lambda_zip     = "${path.module}/build/lambda.zip"
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = local.lambda_src_dir
  output_path = local.lambda_zip
}

# Execution role for Lambda
resource "aws_iam_role" "lambda_exec" {
  name = var.iam_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = { Service = "lambda.amazonaws.com" },
      Action = "sts:AssumeRole"
    }]
  })
}

# Basic logging
resource "aws_iam_role_policy_attachment" "lambda_basic_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Custom permissions (SSM read, S3 write, optional KMS decrypt)
resource "aws_iam_policy" "lambda_extra" {
  name        = "${var.iam_role_name}-extra"
  description = "Allow Lambda to read SSM params and write CSV to S3"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid: "ReadHierarchicalParams",
        Effect: "Allow",
        Action: [
          "ssm:GetParametersByPath",
          "ssm:GetParameters",
          "ssm:GetParameter"
        ],
        Resource: [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.param_prefix}*"
        ]
      },
      {
        Sid: "DecryptIfSecureString",
        Effect: "Allow",
        Action: ["kms:Decrypt"],
        Resource: "*"
      },
      {
        Sid: "S3WriteAndReadCsv",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
        Resource: [
          "arn:aws:s3:::${var.s3_bucket_name}",
          "arn:aws:s3:::${var.s3_bucket_name}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_extra_attach" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_extra.arn
}

data "aws_caller_identity" "current" {}

# Optional: ensure Log Group exists w/ retention
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.lambda_function_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "cleanup" {
  function_name = var.lambda_function_name
  role          = aws_iam_role.lambda_exec.arn
  filename      = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  handler = "index.handler"
  runtime = "nodejs20.x"
  timeout = 30
  memory_size = 256

  # Your code loads most settings from SSM; we pass the prefix here
  environment {
    variables = {
      PARAM_PREFIX = var.param_prefix
      # You can also set DELETED_BY or others if desired
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic_logs,
    aws_iam_role_policy_attachment.lambda_extra_attach,
    aws_cloudwatch_log_group.lambda
  ]
}

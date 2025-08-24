variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "lambda_function_name" {
  description = "Name of the Lambda function"
  type        = string
  default     = "auth0-cleanup-lambda"
}

variable "param_prefix" {
  description = "Path prefix in SSM Parameter Store (hierarchical)"
  type        = string
  default     = "/auth0-cleanup/"
}

variable "s3_bucket_name" {
  description = "S3 bucket where CSV is written (must match SSM value S3_BUCKET)"
  type        = string
  default     = "auth0-deleted-users"
}

variable "iam_role_name" {
  description = "Execution role for Lambda"
  type        = string
  default     = "auth0-cleanup-lambda-exec"
}

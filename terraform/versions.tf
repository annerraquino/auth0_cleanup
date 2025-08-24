terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
  # Optional: uncomment to use a remote backend later
  # backend "s3" {
  #   bucket = "your-tf-state-bucket"
  #   key    = "auth0-cleanup/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region
}

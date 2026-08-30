
terraform {
  # S3-native state locking (use_lockfile) landed in Terraform 1.10. Pinning the
  # floor here makes an older binary fail fast at init instead of quietly
  # initialising a backend with no locking at all.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pessimistic bound: allow 6.19+ (needed for nodejs24.x) but never a
      # future major (7.x), so provider major upgrades stay intentional.
      version = "~> 6.19"
    }
  }
  backend "s3" {
    encrypt = true
    # State and lock both live in S3: the lock is a <key>.tflock object beside
    # the state object. The shared DynamoDB lock table is upstream-owned and is
    # deliberately left in place for the other stacks that still use it.
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      Tenant      = var.tenant
      CreatedBy   = "Terraform"
      Purpose     = "School Email Scheduler"
    }
  }
}

provider "aws" {
  region              = "us-east-1"
  alias               = "aws_global"
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      Tenant      = var.tenant
      CreatedBy   = "Terraform"
      Purpose     = "ScheduledTasks"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_default_tags" "current" {}

data "terraform_remote_state" "basestack" {
  backend = "s3"
  config = {
    bucket = var.terraform_remote_state_basestack_config["bucket"]
    key    = var.terraform_remote_state_basestack_config["key"]
    region = var.terraform_remote_state_basestack_config["region"]
  }
}

data "terraform_remote_state" "legacystack" {
  backend = "s3"
  config = {
    bucket = var.terraform_remote_state_legacystack_config["bucket"]
    key    = var.terraform_remote_state_legacystack_config["key"]
    region = var.terraform_remote_state_legacystack_config["region"]
  }
}

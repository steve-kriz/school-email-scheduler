
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

# THERE IS NO WRONG-ACCOUNT GUARD ON THIS PROVIDER. This is deliberate, not an
# oversight. `allowed_account_ids = [var.account_id]` used to sit here and abort
# a plan/apply run against credentials for an account other than the one named
# in the tfvars file. TASK-051 removed var.account_id, and there is no
# like-for-like replacement: allowed_account_ids cannot be sourced from
# data.aws_caller_identity.current, because that data source is read THROUGH the
# very provider block being configured, which is a dependency cycle. Rather than
# keep an account-id variable alive solely to feed this one argument, the guard
# was dropped as an accepted, informed regression.
#
# What that costs: applying with the wrong AWS credentials no longer fails fast
# at plan time. It will instead create this stack's resources in whatever
# account the ambient credentials point at. Until something replaces this check,
# the account you are pointed at is only ever asserted by the profile in
# terraform_init_dev_au.sh - check `aws sts get-caller-identity` before an apply.
provider "aws" {
  region = var.region

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

# The `aws_global` (us-east-1) provider alias was removed by TASK-051: no
# resource in this stack ever set `provider = aws.aws_global`.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_default_tags" "current" {}

# Read (not written) by this stack: outputs.vpc_id and outputs.private_subnet_ids
# wire the Lambda into the VPC in lambda_calendar.tf. Do not remove - the
# companion `legacystack` remote state was dead and was deleted by TASK-051,
# this one is load-bearing.
data "terraform_remote_state" "basestack" {
  backend = "s3"
  config = {
    bucket = var.terraform_remote_state_basestack_config["bucket"]
    key    = var.terraform_remote_state_basestack_config["key"]
    region = var.terraform_remote_state_basestack_config["region"]
  }
}


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

# THIS STACK READS NO REMOTE STATE. data.terraform_remote_state.basestack used
# to sit here and was removed by TASK-052, together with
# var.terraform_remote_state_basestack_config and the tfvars block that set it.
# Its only two readers were in lambda_calendar.tf - outputs.private_subnet_ids
# fed the Lambda's vpc_config and outputs.vpc_id fed
# aws_security_group.calendar_sg - and TASK-052 removed the VPC attachment and
# the security group, leaving the state with no reader at all. (The companion
# `legacystack` remote state had already been deleted as dead by TASK-051.)
#
# Nothing here depends on the basestack outputs any more, so this stack no
# longer needs read access to the basestack state object. If a future ticket
# genuinely needs a basestack value, re-add the data source AND its variable AND
# the tfvars key in the same change - a variable with no default and no value is
# a hard error.

locals {
  name_prefix = "${var.tenant}-${var.environment}-${var.project_name}"
}

locals {
  secret_name = "${var.environment}-${var.tenant}/app-config/school_calendar_services"
}

variable "project_name" {
  description = "Name of Project"
  type        = string
}

# var.project_name_short (and local.name_prefix_short, built from it) was removed
# by TASK-051. Its only consumer was the ALB target group's 32-character-capped
# name, which TASK-049 deleted along with the rest of the ALB ingress.

# var.account_id was removed by TASK-051. The two places that still needed an
# account id in a constructed ARN - local.calendar_function_arn in
# lambda_calendar.tf and the ManageScanSchedules resource scope in
# scheduler_calendar.tf - now read data.aws_caller_identity.current.account_id,
# the same source kms_calendar.tf already used.

variable "environment" {
  description = "Name of Environment"
  type        = string
}

variable "region" {
  description = "Region"
  type        = string
}

variable "tenant" {
  description = "Region short name"
  type        = string
}

# var.terraform_remote_state_basestack_config and its
# data.terraform_remote_state.basestack in provider.tf were removed by TASK-052,
# which deleted the Lambda's vpc_config and aws_security_group.calendar_sg - the
# only two consumers of that state's private_subnet_ids and vpc_id outputs. The
# declaration and the tfvars key in config/dev/au.tfvars went in the SAME change
# (an orphaned tfvars key only warns, but a declaration with no default and no
# value is a hard error, so the two sides must move together).
#
# var.terraform_remote_state_legacystack_config and its own
# data.terraform_remote_state.legacystack had already been removed by TASK-051 -
# nothing in this stack ever read an output from that state. This stack now
# reads NO remote state at all.

# var.timezone, var.geo_id and var.language - per-tenant maps keyed au/uk/us -
# were removed by TASK-051. Nothing referenced them, and this stack now deploys
# a single environment (dev/au), so there is no per-tenant lookup to serve.

variable "Alert_SNS_ARN" {
  description = "The ARN the alerts will go"
  type        = string
}

# var.hosted_zone_id, var.hosted_zone, var.sub_domain and var.alb_name were
# removed by TASK-051. TASK-049 replaced the ALB + Route53 ingress with
# aws_lambda_function_url.calendar, which left all four declared but read by
# nothing; TASK-051 deleted the declarations and the tfvars keys that set them
# in the same change (an orphaned tfvars key only warns, but a declaration with
# no default and no value is a hard error, so the two sides must move together).
# There is no repo-owned hostname in front of the function URL - if one is ever
# put there, PUBLIC_BASE_URL is the knob, not these.

variable "manage_lambda_log_groups" {
  description = <<-EOT
    Whether Terraform manages the Lambda CloudWatch log groups.

    The log group is normally auto-created by the Lambda runtime the first time
    the function writes a log event, so Terraform does not need to own it. For
    NEW environments the Lambda has never run, so the group does not exist yet
    and the CloudWatch metric filters in alerting.tf fail with
    ResourceNotFoundException - set this to true so the group is created first.

    For existing environments whose group is already present (auto-created,
    unmanaged), leave this false to avoid a ResourceAlreadyExistsException - or
    `terraform import` the group and then flip it.
  EOT
  type        = bool
  default     = false
}

variable "calendar_log_level" {
  description = "Calendar Lambda log verbosity: none (errors only), basic (request/summary lines) or verbose (per-email extraction detail - contains personal data, do not leave on in prod)"
  type        = string
  default     = "basic"

  validation {
    condition     = contains(["none", "basic", "verbose"], var.calendar_log_level)
    error_message = "calendar_log_level must be one of: none, basic, verbose."
  }
}

variable "anthropic_model" {
  description = <<-EOT
    Anthropic model id used to extract calendar events from school emails.

    Default is claude-opus-5 (the current Opus, 1M context, $5/$25 per MTok).
    claude-sonnet-5 is the cheaper option ($3/$15 per MTok) and gives near-Opus
    quality on this class of structured-extraction task, so it is a reasonable
    swap for cost-sensitive environments.

    This is a PLAIN model id with NO DATE SUFFIX - do not append something like
    -20250514; dated aliases are not valid here and will fail at call time.
  EOT
  type        = string
  default     = "claude-opus-5"
}

variable "tags" {
  description = "A map of tags to assign to the resource."
  type        = map(string)
  default = {
    Purpose = "SchoolEmailScheduler"
    Project = "School_Calendar"
  }
}

# var.calendar_waf_rate_limit and var.calendar_scan_rate_limit were removed by
# TASK-049 along with aws_wafv2_rule_group.calendar_protection. The app is served
# from a Lambda function URL, which no AWS WAF regional Web ACL can be associated
# with, so there is no longer anything for a rate limit to be configured ON. They
# were deleted rather than left declared because a variable that names a path it
# no longer protects reads like live protection to the next person.

variable "public_base_url" {
  description = <<-EOT
    Override for PUBLIC_BASE_URL, the public origin the calendar app is served
    from, with NO trailing slash (e.g. https://example.com).

    Leave empty - the default - unless something is put in front of the Lambda
    function URL. Empty makes the handler derive the origin from each incoming
    request's own function-URL host, which is always the origin the app is
    actually being served from and needs no update if the function URL is ever
    recreated with a new URL id.

    Whatever this resolves to, the Google OAuth redirect_uri is built from it as
    <origin>/calendar/api/auth/google/callback and that exact string must be
    registered on the OAuth client in the Google Cloud console.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.public_base_url == "" || can(regex("^https?://[^/]+$", var.public_base_url))
    error_message = "public_base_url must be empty, or a scheme + host with no path and no trailing slash (e.g. https://example.com)."
  }
}

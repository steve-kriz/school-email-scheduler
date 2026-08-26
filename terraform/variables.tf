locals {
  name_prefix = "${var.tenant}-${var.environment}-${var.project_name}"
}

locals {
  name_prefix_short = "${var.tenant}-${var.environment}-${var.project_name_short}"
}

locals {
  secret_name = "${var.environment}-${var.tenant}/app-config/school_calendar_services"
}

variable "project_name" {
  description = "Name of Project"
  type        = string
}


variable "project_name_short" {
  description = "Name of Project abbreviated, mainly so the target group can be created"
  type        = string
}


variable "account_id" {
  description = "AWS Account ID"
  type        = string
}

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

variable "terraform_remote_state_basestack_config" {
  description = "Terraform Remote State Config"
  type        = map(string)
}

variable "terraform_remote_state_legacystack_config" {
  description = "Terraform Remote State Config"
  type        = map(string)
}

variable "timezone" {
  description = "Timezone of the tenant"
  type        = map(string)
  default = {
    au = "AUS Eastern Standard Time"
    uk = "GMT Standard Time"
    us = "US Mountain Standard Time"
  }
}

variable "geo_id" {
  description = "Geo ID of the tenant"
  type        = map(number)
  default = {
    au = 12
    uk = 242
    us = 244
  }
}

variable "language" {
  description = "Language of the tenant"
  type        = map(string)
  default = {
    au = "en-AU"
    uk = "en-GB"
    us = "en-US"
  }
}

variable "Alert_SNS_ARN" {
  description = "The ARN the alerts will go"
  type        = string
}

variable "hosted_zone_id" {
  description = "the zone id to attach the sub-domain to like (Z01295023U1SROTEMSPWK)"
  type        = string
}

variable "hosted_zone" {
  description = "the hosted zone like au.dev.receptionhq.com that the domain will live on"
  type        = string
}

variable "sub_domain" {
  description = "the sub domain to be created for the web app"
  type        = string
}

variable "alb_name" {
  description = "the name of the alb to attach to"
  type        = string
}


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

variable "calendar_waf_rate_limit" {
  description = <<-EOT
    Maximum requests per 5-minute period per IP for the /calendar* paths.

    300 matches the chatbot's own var.chatbot_waf_rate_limit. Applied by
    aws_wafv2_rule_group.calendar_protection in waf_calendar.tf, and NOT
    applied to the Google OAuth callback, which is explicitly allowed first -
    see the callback rule's comment for why (schools NAT their whole staff
    behind one egress IP, so sign-in arrives as a single-IP burst).

    AWS WAF rejects a rate-based limit below 10.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.calendar_waf_rate_limit >= 10
    error_message = "calendar_waf_rate_limit must be at least 10 (the AWS WAF rate-based rule minimum)."
  }
}

variable "calendar_scan_rate_limit" {
  description = <<-EOT
    Maximum requests per 5-minute period per IP for /calendar/api/scan.

    Deliberately much tighter than calendar_waf_rate_limit: one scan fans out
    into Gmail API calls and one Anthropic completion PER EMAIL, so its cost is
    measured in model tokens rather than CPU. Keep this BELOW
    calendar_waf_rate_limit - Terraform 1.8 cannot express that as a variable
    validation (cross-variable references need 1.9+), so it is an invariant the
    defaults satisfy (10 < 300) and an override must preserve.

    10 is also the AWS WAF floor for a rate-based rule limit; lower values are
    rejected by the API.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.calendar_scan_rate_limit >= 10
    error_message = "calendar_scan_rate_limit must be at least 10 (the AWS WAF rate-based rule minimum)."
  }
}

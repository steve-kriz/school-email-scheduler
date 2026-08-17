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


variable "tags" {
  description = "A map of tags to assign to the resource."
  type        = map(string)
  default = {
    Purpose = "SchoolEmailScheduler"
    Project = "School_Calendar"
  }
}

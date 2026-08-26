# =============================================================================
# WAF rule group for the calendar endpoints (TASK-011)
# =============================================================================
# Follows ohq-chatbot2/terraform/waf_chatbot.tf exactly in MECHANISM: this
# service does NOT create its own aws_wafv2_web_acl and does NOT create an
# aws_wafv2_web_acl_association. It publishes a REGIONAL aws_wafv2_rule_group
# and exports its ARN, and that rule group is referenced from the SHARED ALB's
# Web ACL, which is owned by the basestack (tf-cloudinfra:
# aws_wafv2_web_acl.web_app_alb, "<tenant>-<env>-<project>-acl-alb").
#
# WHY IT MUST BE THIS WAY, not a web ACL of our own:
#   - An ALB can have exactly ONE Web ACL associated with it. The basestack
#     already associates its own to this shared ALB, so a second ACL declared
#     here could never be attached; applying one would either fail or fight the
#     basestack for the association.
#   - AWS WAF does not permit a managed_rule_group_statement inside an
#     aws_wafv2_rule_group - managed rule groups can only be referenced from a
#     Web ACL. See "MANAGED RULE GROUPS" below for how they still apply here.
#
# TO WIRE THIS UP, add the following to the basestack Web ACL (this is the same
# hand-off the chatbot documents in ohq-chatbot2/docs/add-waf-rule-group-to-basestack.md):
#
#   rule {
#     name     = "calendar-protection"
#     priority = 120  # chatbot-protection owns 119; must be < 200 (see below)
#     override_action { none {} }
#     statement {
#       rule_group_reference_statement {
#         arn = "<output.calendar_waf_rule_group_arn>"
#       }
#     }
#     visibility_config {
#       cloudwatch_metrics_enabled = true
#       metric_name                = "calendar-protection"
#       sampled_requests_enabled   = false  # see PRIVACY below
#     }
#   }
#
# PRIORITY MATTERS. In the basestack ACL the AWS managed rule groups sit at
# priorities 200-500 in COUNT mode, and a terminating "BlockAllManagedMatches"
# rule at priority 900 turns any label they attach into a block. So a rule
# group referenced at 120 is evaluated BEFORE all of them - which is exactly
# what makes the OAuth-callback allow rule below able to save sign-in from a
# managed-rule false positive (the same failure mode the chatbot hit with
# EC2MetaDataSSRF_BODY).
#
# MANAGED RULE GROUPS: the calendar inherits precisely the chatbot's selection,
# because the chatbot declares none of its own either - both are protected by
# the managed rule groups already attached to the shared ALB ACL by the
# basestack. That selection is mirrored in
# local.calendar_waf_inherited_managed_rule_groups below and exported as
# output.calendar_waf_managed_rule_groups so it can be diffed against the live
# ACL, since it cannot be declared as a rule here.
#
# PRIVACY (no credentials to any log destination): this file creates NO
# aws_wafv2_web_acl_logging_configuration - the chatbot has none, and inventing
# a logging destination for the shared ACL is not this service's call. The one
# content-bearing knob a rule group does have is
# `sampled_requests_enabled`, which stores whole sampled requests INCLUDING
# Cookie and Authorization headers (and, on the callback path, the live OAuth
# `code` query parameter) for viewing in the WAF console. It is therefore set
# to FALSE on every rule and on the rule group itself - a deliberate departure
# from the chatbot, which enables it. cloudwatch_metrics_enabled stays true:
# those are counts only and carry no request content.
# =============================================================================

locals {
  # The AWS managed rule groups the shared ALB Web ACL applies, in basestack
  # priority order (source: tf-cloudinfra config/<env>/<tenant>.tfvars,
  # waf.managed_rules_alb - all in "count" mode, with the terminating
  # BlockAllManagedMatches rule at priority 900 acting on their labels).
  # Documented and exported, not declared: see MANAGED RULE GROUPS above.
  calendar_waf_inherited_managed_rule_groups = [
    "AWSManagedRulesWindowsRuleSet",
    "AWSManagedRulesCommonRuleSet",
    "AWSManagedRulesSQLiRuleSet",
    "AWSManagedRulesKnownBadInputsRuleSet",
  ]
}

resource "aws_wafv2_rule_group" "calendar_protection" {
  name        = "${local.name_prefix}-calendar-waf-rules"
  description = "School calendar rate limiting and OAuth callback protection"
  scope       = "REGIONAL"
  # A rule group's capacity is IMMUTABLE after creation, so this is set with
  # headroom rather than to the exact current consumption (~50 WCU: two
  # rate-based rules at 2 WCU each plus byte-match/text-transformation costs).
  # Growing it later means replacing the rule group and re-pointing the ARN in
  # the basestack ACL.
  capacity = 100

  # --- Rule 1: tight rate limit on /calendar/api/scan ---
  # First, so it is evaluated before the broad /calendar* limit and before the
  # callback allow. A scan is the expensive route in this app: it fans out into
  # Gmail API calls and one Anthropic completion PER EMAIL, so its cost is
  # measured in model tokens, not CPU. Page loads can afford
  # var.calendar_waf_rate_limit; this cannot.
  #
  # Note both this and Rule 3 will count a /calendar/api/scan request, and this
  # (stricter) rule blocks first. That overlap is intended.
  rule {
    name     = "calendar-scan-rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.calendar_scan_rate_limit
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/calendar/api/scan"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-calendar-scan-rate-limit"
      # See PRIVACY in the header: sampled requests capture cookies and headers.
      sampled_requests_enabled = false
    }
  }

  # --- Rule 2: never block the Google OAuth callback ---
  # An explicit, TERMINATING allow, narrowly scoped to GET
  # /calendar/api/auth/google/callback. Two independent reasons, both of which
  # break sign-in silently and are only visible in WAF logs:
  #
  #   1. The callback carries long, opaque `code` and `state` query parameters.
  #      The basestack ACL runs AWSManagedRulesCommonRuleSet in count mode and
  #      then BLOCKS on its labels at priority 900, so a false positive from a
  #      generic/size rule on that query string (SizeRestrictions_QUERYSTRING
  #      and friends) would turn every sign-in into a WAF block. Referenced at
  #      priority 120 the allow here wins, because it is evaluated first.
  #   2. Schools NAT their whole staff behind one egress IP, so sign-in traffic
  #      arrives as a burst from a SINGLE address - the exact shape per-IP rate
  #      limiting is designed to stop. This allow deliberately exempts the
  #      callback from Rule 3 for that reason; the route is cheap (one token
  #      exchange, then a redirect) and it is the one path where a false block
  #      locks users out of the product entirely.
  #
  # Scoped as tightly as WAF allows - method AND path - so it is not a
  # /calendar/api/* allow-all. (The chatbot's rule group DOES allow-all on
  # /chatbot/api/, which is why its own rate-limit rule is dead code; that
  # mistake is not repeated here.)
  rule {
    name     = "calendar-oauth-callback-allow"
    priority = 2

    action {
      allow {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = "/calendar/api/auth/google/callback"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }

        statement {
          byte_match_statement {
            # Lower-cased by the transformation below, so the literal is too.
            search_string         = "get"
            positional_constraint = "EXACTLY"

            field_to_match {
              method {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-calendar-oauth-callback-allow"
      # Especially here: a sampled request on this path would retain the live
      # OAuth authorization `code` from the query string.
      sampled_requests_enabled = false
    }
  }

  # --- Rule 3: baseline rate limit on /calendar* ---
  # Page loads, static assets and the settings/events APIs. Matches the ALB
  # listener rule's own /calendar* path pattern (lambda_calendar.tf), so
  # everything routed to this Lambda is covered.
  rule {
    name     = "calendar-rate-limit"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.calendar_waf_rate_limit
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/calendar"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-calendar-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-calendar-protection"
    sampled_requests_enabled   = false
  }

  tags = merge(var.tags, {
    Purpose = "School Calendar API Protection"
  })
}

# --- Outputs for the basestack hand-off (the chatbot's mechanism) ---

output "calendar_waf_rule_group_arn" {
  description = "ARN of the calendar WAF rule group - reference it from the shared ALB Web ACL in the basestack at a priority BELOW the managed rule groups (200) and BlockAllManagedMatches (900); 120 is free, the chatbot owns 119"
  value       = aws_wafv2_rule_group.calendar_protection.arn
}

output "calendar_waf_managed_rule_groups" {
  description = "AWS managed rule groups the calendar paths are protected by, inherited from the shared ALB Web ACL (basestack-owned, count mode + BlockAllManagedMatches). Exported so the inherited selection can be diffed against the live ACL - it cannot be declared inside an aws_wafv2_rule_group"
  value       = local.calendar_waf_inherited_managed_rule_groups
}

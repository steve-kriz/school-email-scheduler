# =============================================================================
# CloudWatch alerting for the school calendar Lambda (TASK-011)
# =============================================================================
# Mirrors ohq-chatbot2/terraform/alerting.tf: log metric filters over the
# Lambda's log group, plus CloudWatch alarms that notify the shared SNS topic
# (var.Alert_SNS_ARN). Naming, tagging and the "the SNS topic MUST be in this
# alarm's own region" rule all follow that file.
#
# TWO DELIBERATE DIFFERENCES FROM THE CHATBOT, both explained where they occur:
#
#   1. EVERY ALARM IS GUARDED BY count = var.Alert_SNS_ARN == "" ? 0 : 1
#      rather than the chatbot's "empty actions list" trick. dev/au sets
#      Alert_SNS_ARN = "" (see config/dev/au.tfvars), and that is the first
#      environment the calendar deploys to: an alarm with no action there is
#      pure cost and noise, so it is not created at all. The metric FILTERS are
#      NOT guarded - they are free, and letting the metrics accumulate in dev
#      means the alarms have history the moment a topic is configured.
#
#   2. ALARM PERIODS ARE SINGLE-DATAPOINT, not the chatbot's 3-of-3. This
#      Lambda is invoked sparsely (one scheduled scan per connected user per
#      day, plus interactive settings/scan requests - see
#      scheduler_calendar.tf), so a rule requiring three CONSECUTIVE breaching
#      5-minute periods would essentially never fire: errors arrive in a single
#      period and then the function is idle again.
#
# LOG-GROUP ORDERING (the same problem the chatbot documents):
# A metric filter requires its log group to already exist. The calendar log
# group is normally auto-created by the Lambda runtime on first invocation and
# is NOT Terraform-managed (see lambda_calendar.tf), so on a FRESH environment
# where the function has never run it does not exist yet and these filters fail
# with ResourceNotFoundException. A fresh environment must therefore apply with
# var.manage_lambda_log_groups = true, which makes
# aws_cloudwatch_log_group.calendar_lambda_logs create the group first; the
# depends_on on each filter below then orders the filter after it. When
# var.manage_lambda_log_groups is false the depends_on is a no-op (count = 0)
# and the pre-existing auto-created group is used as-is.
#
# PRIVACY: nothing in this file is a log destination. The metric filters emit
# COUNTS only (value = "1"), never matched log content, and no alarm carries a
# request body, a cookie or an Authorization header anywhere. Message bodies,
# subjects and tokens are kept out of the Lambda's logs by the backend modules
# themselves; nothing here can reintroduce them.
# =============================================================================

# -----------------------------------------------------------------------------
# Lambda runtime alarms (AWS/Lambda metrics - no filter needed)
# -----------------------------------------------------------------------------

# --- Errors ---
# Threshold 0 over a single 5-minute datapoint: ANY invocation error is worth
# notifying on here. A failed SCHEDULED scan is completely silent to the user -
# nobody is watching a browser when it runs - so CloudWatch is the only place
# it ever surfaces.
resource "aws_cloudwatch_metric_alarm" "calendar_lambda_errors" {
  count = var.Alert_SNS_ARN == "" ? 0 : 1

  alarm_name          = "${local.name_prefix}-school-calendar-lambda-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.calendar.function_name
  }

  alarm_description = "School calendar Lambda reported one or more invocation errors in a 5-minute period"

  # The SNS topic MUST be in this alarm's region (var.region).
  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# --- Throttles ---
# Concurrency exhaustion. A throttled scheduled scan is never run at all, and a
# throttled interactive request is a 429 from the function URL (it was a 502 at
# the ALB before TASK-049), so any throttle is a real fault - never a normal
# operating condition for this workload.
resource "aws_cloudwatch_metric_alarm" "calendar_lambda_throttles" {
  count = var.Alert_SNS_ARN == "" ? 0 : 1

  alarm_name          = "${local.name_prefix}-school-calendar-lambda-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.calendar.function_name
  }

  alarm_description = "School calendar Lambda was throttled - a scheduled scan may have been dropped entirely"

  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Removed: extraction-failure and re-auth-required log metric filters/alarms
# -----------------------------------------------------------------------------
# aws_cloudwatch_log_metric_filter.calendar_extraction_failed/calendar_reauth_required
# and their two alarms required the Lambda's log group to already exist
# (ResourceNotFoundException on a fresh environment otherwise) and the deploying
# IAM identity to have log-group-related permissions this account's user does
# not have. Removed by explicit request during first deploy rather than granting
# more IAM access or setting var.manage_lambda_log_groups = true. KNOWN GAP: no
# CloudWatch signal for a systemic extraction failure spike (Anthropic 5xx/429,
# every message refused) or a fleet-wide Gmail re-auth event any more - both
# fail silently now, visible only in the raw Lambda logs if someone goes
# looking. The AWS/Lambda Errors/Throttles alarms above are unaffected.
# -----------------------------------------------------------------------------
# Removed: ALB target-group health (TASK-049)
# -----------------------------------------------------------------------------
# aws_cloudwatch_metric_alarm.calendar_target_group_unhealthy_hosts used to
# alarm on AWS/ApplicationELB UnHealthyHostCount, dimensioned on the calendar
# target group and the shared ALB. TASK-049 moved the app onto a Lambda function
# URL and deleted the target group, so neither dimension can report a datapoint
# ever again.
#
# It was DELETED rather than re-pointed or left in place: an alarm on a metric
# that never reports never fires, so it sits green forever and looks like
# coverage. That is worse than the honest gap.
#
# KNOWN GAP, recorded here on purpose: the ALB health check was the only thing
# calling /calendar/api/health (every 300s). Nothing calls it now, so there is
# no synthetic probe of this app's liveness at all - the alarms above only fire
# on activity the Lambda itself generates (errors, throttles, log patterns), so
# a function that is broken AND idle is invisible. Restoring a probe needs
# something that polls the function URL on a schedule (a CloudWatch Synthetics
# canary or an EventBridge-driven checker), which TASK-049 did not build.

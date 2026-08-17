# =============================================================================
# DynamoDB: School Calendar extracted events
# =============================================================================
# One row per calendar event extracted from a school email. Written by the
# scanner Lambda, read by the calendar UI (month view) and the "needs attention"
# list.
#
# Schema (all fields are strings unless noted):
#   userId (PK)         : "google#<google sub claim>", same value as the
#                         connections table
#   eventId (SK)        : deterministic sha256 hex of
#                           `sourceMessageId | normalisedTitle | startsAt`
#                         Because the key is derived from content rather than
#                         generated, re-scanning the same email produces the same
#                         eventId and the PutItem simply overwrites the existing
#                         row - a rescan can NEVER duplicate an event.
#   title               : short event title, e.g. "Sports Carnival"
#   description         : longer detail extracted from the email body
#   location            : where the event happens, free text
#   category            : e.g. "excursion" | "sport" | "payment" | "assembly"
#   startsAt            : ISO-8601 start timestamp
#   endsAt              : ISO-8601 end timestamp
#   allDay (BOOL)       : true when no time-of-day was stated
#   needsAttention (BOOL) : the event requires the parent to do something
#   actionRequired      : what the parent must do, e.g. "Return permission slip"
#   dueBy               : ISO-8601 deadline for actionRequired
#   status              : "pending" | "acknowledged" | "dismissed"
#   sourceMessageId     : Gmail message ID the event was extracted from
#   sourceSubject       : subject line of that email
#   sourceFrom          : sender address of that email
#   sourceReceivedAt    : ISO-8601 receipt time of that email
#   confidence (N)      : model-reported extraction confidence, 0-1
#   attentionKey        : SPARSE GSI key - see AttentionIndex below
#   createdAt           : ISO-8601, first extraction
#   updatedAt           : ISO-8601, last mutation
#   ttl (N)             : epoch seconds; long-past events age out automatically
#
# -----------------------------------------------------------------------------
# StartsAtIndex (hash userId, range startsAt, projection ALL)
# -----------------------------------------------------------------------------
# Backs the calendar month view: a single Query with a BETWEEN condition on
# startsAt returns exactly the month's events, instead of fetching every event
# for the user and filtering in memory. Projection is ALL because the month view
# renders the full event card.
#
# -----------------------------------------------------------------------------
# AttentionIndex (hash attentionKey, range dueBy, projection ALL)
# -----------------------------------------------------------------------------
# SPARSE BY DESIGN. Only events that are BOTH `needsAttention = true` AND
# `status = "pending"` carry an `attentionKey` attribute, whose value is
# "<userId>#pending". DynamoDB only indexes items that have the index's hash key,
# so the index contains just the actionable rows - the "needs attention" list is
# an O(actionable-per-user) Query sorted by deadline rather than an O(table) Scan
# with a filter.
#
# The lifecycle contract the application MUST honour:
#   * on extraction, if needsAttention && status == "pending" -> set
#     attentionKey = "<userId>#pending"
#   * on acknowledge or dismiss -> REMOVE the attentionKey attribute (a DynamoDB
#     UpdateExpression `REMOVE attentionKey`, not setting it to ""), which drops
#     the item out of the index
# Writing an empty string would fail the write; leaving the attribute in place
# would leave handled events showing as actionable forever.
#
# WARNING: querying a GSI needs its own IAM grant. The Lambda's dynamodb:Query
# permission must cover BOTH the table ARN and "<table arn>/index/*", otherwise
# the Query fails at runtime with AccessDeniedException even though GetItem on
# the same table succeeds.
# =============================================================================

resource "aws_dynamodb_table" "calendar_events" {
  name         = "${local.name_prefix}-calendar-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "eventId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "eventId"
    type = "S"
  }

  # Range key of StartsAtIndex.
  attribute {
    name = "startsAt"
    type = "S"
  }

  # Hash and range key of the sparse AttentionIndex. Declaring them here does
  # not make them mandatory on every item - only items that carry attentionKey
  # appear in the index.
  attribute {
    name = "attentionKey"
    type = "S"
  }

  attribute {
    name = "dueBy"
    type = "S"
  }

  global_secondary_index {
    name            = "StartsAtIndex"
    hash_key        = "userId"
    range_key       = "startsAt"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "AttentionIndex"
    hash_key        = "attentionKey"
    range_key       = "dueBy"
    projection_type = "ALL"
  }

  # Events are stamped with a ttl well past their end date so the table (and
  # both GSIs) stay bounded without a cleanup job.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # Events are re-derivable by re-scanning the mailbox, but PITR is cheap here
  # and preserves user acknowledgements, which are not reconstructable.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.calendar.arn
  }

  tags = merge(var.tags, {
    Purpose = "School Calendar extracted events"
  })
}

output "calendar_events_table_name" {
  description = "Name of the school calendar events table"
  value       = aws_dynamodb_table.calendar_events.name
}

output "calendar_events_table_arn" {
  description = "ARN of the school calendar events table - the Lambda IAM policy must also allow <arn>/index/* for GSI queries"
  value       = aws_dynamodb_table.calendar_events.arn
}

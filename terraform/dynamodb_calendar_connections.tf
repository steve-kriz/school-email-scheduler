# =============================================================================
# DynamoDB: School Calendar Google account connections
# =============================================================================
# One row per connected Google account. Holds the encrypted Gmail refresh token
# (the app's only copy of the OAuth grant), the school/domain matching config,
# the scan watermark, and the user's scan schedule preferences.
#
# Every access path is a GetItem or PutItem by `userId`, so there is deliberately
# no GSI and no range key - adding one would only add write cost.
#
# Schema (all fields are strings unless noted):
#   userId (PK)         : "google#<google sub claim>"
#   email               : the connected Google account address
#   schoolName          : free-text school name entered by the user
#   searchDomains (SS)  : domains to match senders against, e.g.
#                         ["stmarys.nsw.edu.au", "schoolbytes.education"]
#   refreshTokenEnc     : base64 KMS ciphertext of the Gmail refresh token. The
#                         PLAINTEXT TOKEN IS NEVER WRITTEN TO THIS TABLE - there
#                         is intentionally no `refreshToken` attribute anywhere
#                         in this schema. Encrypt/decrypt with the CMK in
#                         kms_calendar.tf.
#   refreshTokenKeyId   : the CMK ARN used to wrap refreshTokenEnc, so a key
#                         rotation or key change can be detected per row and the
#                         token re-wrapped rather than silently failing to
#                         decrypt.
#   lastHistoryId       : Gmail history ID watermark from the last successful
#                         scan; lets the next scan fetch only new messages.
#   lastScanAt          : ISO-8601 timestamp of the last scan attempt
#   lastScanStatus      : "success" | "error" | "running"
#   lastScanError       : last error message, surfaced in the UI
#   scheduleEnabled (BOOL) : master switch for the automated scan
#   scheduleFrequency   : "daily" | "weekly"
#   scheduleHour        : hour-of-day (0-23) in `timezone` to run the scan
#   timezone            : IANA zone, e.g. "Australia/Sydney"
#   createdAt           : ISO-8601, when the account was first connected
#   updatedAt           : ISO-8601, last mutation
#
# point_in_time_recovery is ON (unlike the chatbot tables): this table holds the
# only copy of each user's OAuth grant, and an accidental delete would force
# every user to re-consent. server_side_encryption uses the project CMK so the
# stored ciphertext is protected by two independent keys.
# =============================================================================

resource "aws_dynamodb_table" "calendar_connections" {
  name         = "${local.name_prefix}-calendar-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.calendar.arn
  }

  tags = merge(var.tags, {
    Purpose = "School Calendar Google account connections"
  })
}

output "calendar_connections_table_name" {
  description = "Name of the school calendar connections table"
  value       = aws_dynamodb_table.calendar_connections.name
}

output "calendar_connections_table_arn" {
  description = "ARN of the school calendar connections table"
  value       = aws_dynamodb_table.calendar_connections.arn
}

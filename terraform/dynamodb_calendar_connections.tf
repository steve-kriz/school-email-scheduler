# =============================================================================
# DynamoDB: School Calendar Google account connections
# =============================================================================
# One row per connected Google account. Holds the encrypted Gmail refresh token
# (the app's only copy of the OAuth grant), the school/domain matching config,
# the scan watermark, and the user's scan schedule preferences.
#
# The table is schemaless beyond the `userId` hash key, so the attribute list
# below is documentation rather than a declaration: adding, renaming or retyping
# an attribute (as TASK-053 did for schoolName -> schoolNames) is an application
# change and needs no change to this resource.
#
# Every access path is a GetItem or PutItem by `userId`, so there is deliberately
# no GSI and no range key - adding one would only add write cost.
#
# Schema (all fields are strings unless noted):
#   userId (PK)         : "google#<google sub claim>"
#   email               : the connected Google account address
#   schoolNames (SS)    : free-text school names entered by the user (up to 10),
#                         e.g. ["St Mary's Primary", "St Mary's P&C"]. Used only
#                         as descriptive context in the extraction prompt - the
#                         Gmail query and the watched-sender check are built from
#                         searchDomains alone.
#                         LEGACY: before TASK-053 this was a single scalar string
#                         attribute `schoolName`. A row whose owner has not saved
#                         their settings since may still carry that scalar and no
#                         schoolNames set; connections.mjs's toPublicJson reads it
#                         back as a one-element list, and the next settings save
#                         SETs schoolNames and REMOVEs schoolName in the same
#                         UpdateItem. No row carries both, and there is no batch
#                         migration - rows convert one at a time as they are saved.
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
#   lastScanAt          : ISO-8601 timestamp the incremental watermark is
#                         pinned to (see scan.mjs) - NOT necessarily "when the
#                         last scan ran": a truncated or time-stopped scan pins
#                         this at the query floor it used rather than advancing
#                         it, so a later scan still re-covers whatever this one
#                         dropped.
#   lastScanStatus      : "ok" | "partial" | "reauth_required" | "error"
#   lastScanError       : last error message (short, never a token/body/subject)
#   lastScanMessagesScanned, lastScanEventsCreated, lastScanEventsUpdated,
#   lastScanSkipped, lastScanTruncated (BOOL) : counts/flags from the last scan
#                         (scan.mjs), surfaced by GET /calendar/api/scan/status.
#   scanInProgress (BOOL), scanStartedAt : the per-user scan lock (scan.mjs /
#                         connections.mjs's acquireScanLock+releaseScanLock).
#                         A lock older than SCAN_LOCK_STALE_MS is treated as
#                         abandoned rather than active.
#   scheduleEnabled (BOOL) : master switch for the automated scan
#   scheduleFrequency   : "daily" | "weekly"
#   scheduleHour        : hour-of-day (0-23) in `timezone` to run the scan
#   scheduleDayOfWeek   : 0 (Sunday) - 6 (Saturday); set only when
#                         scheduleFrequency is "weekly"
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

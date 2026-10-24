# Single-table mailbox index. Items hold routing metadata plus ciphertext blobs only:
#   MAILBOX#<address> / META          owner, public key, encrypted private key(s), recovery blobs, quota
#   MAILBOX#<address> / MSG#<ts>#<id> folder, flags, thread HMAC, encrypted header blob, S3 keys
#   MAILBOX#<address> / LABEL#, DRAFT#, SETTINGS (encrypted), QUOTA#<day>
# gsi1: folder listing (MAILBOX#addr#FOLDER#name / ts)   gsi2: thread (THREAD#hmac / ts)

variable "table_name" { type = string }
variable "kms_key_arn" { type = string }

resource "aws_dynamodb_table" "mail" {
  name                        = var.table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "gsi2"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
}

output "table_name" { value = aws_dynamodb_table.mail.name }
output "table_arn" { value = aws_dynamodb_table.mail.arn }

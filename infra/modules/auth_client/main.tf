# A dedicated app client for Mac Tidar Mail on Mac Tidar Cloud's existing user pool.
# Only the client is managed here; the pool (and Cloud's users and settings) is untouched.
# SRP sign-in: the password never leaves the browser, which also lets the browser derive
# the mailbox key from it.

variable "user_pool_id" { type = string }

resource "aws_cognito_user_pool_client" "mail_web" {
  name         = "mactidar-mail-web"
  user_pool_id = var.user_pool_id

  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  supported_identity_providers  = ["COGNITO"]

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 7
  auth_session_validity  = 5

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Read-only access to profile fields; the mail app never edits Cloud profiles.
  read_attributes = ["email", "email_verified", "name"]
}

output "client_id" { value = aws_cognito_user_pool_client.mail_web.id }

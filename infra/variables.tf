variable "region" {
  description = "Everything runs in af-south-1: SES production access, inbound SMTP and Cloud's Cognito pool all live there."
  type        = string
  default     = "af-south-1"
}

variable "account_id" {
  description = "Guard rail: Terraform refuses to run against any other AWS account."
  type        = string
  default     = "831981619011"
}

variable "root_domain" {
  description = "Organisational domain used for DKIM, MAIL FROM and DMARC."
  type        = string
  default     = "mactidar.com"
}

variable "receiving_domains" {
  description = "Domains whose mail SES accepts. The root domain was added at cutover (Phase 7)."
  type        = list(string)
  default     = ["beta.mactidar.com", "mactidar.com"]
}

variable "app_origins" {
  description = "Browser origins allowed to call the mail API and upload/download encrypted blobs."
  type        = list(string)
  default     = ["https://mail.mactidar.com", "http://localhost:3000"]
}

variable "cognito_user_pool_id" {
  description = "Mac Tidar Cloud's shared Cognito user pool. Terraform only adds an app client to it; the pool itself is never modified."
  type        = string
  default     = "af-south-1_378A7d9Bp"
}

variable "alert_email" {
  description = "Where budget and alarm notifications go. Set in terraform.tfvars (not committed)."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for resources tagged Project=mactidar-mail."
  type        = number
  default     = 10
}

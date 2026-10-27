provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "mactidar-mail"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

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

# Amplify Hosting isn't offered in af-south-1; the web front end is hosted from Ireland.
provider "aws" {
  alias               = "eu"
  region              = "eu-west-1"
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "mactidar-mail"
      ManagedBy = "terraform"
    }
  }
}

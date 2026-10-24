# Shares the existing Mac Tidar state bucket (af-south-1, versioned, encrypted, private)
# under its own key so it never touches Mac Tidar Cloud's state.
terraform {
  backend "s3" {
    bucket       = "mactidar-tfstate-831981619011"
    key          = "mactidar-mail/terraform.tfstate"
    region       = "af-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

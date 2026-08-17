# NOTE: Make sure sync up the following variables with tf-basestack Repo
##############################################
project_name       = "receptionhq"
project_name_short = "rhq"
account_id         = "824320358416"
region             = "eu-west-2"
environment        = "prod"
tenant             = "uk"
Alert_SNS_ARN      = "arn:aws:sns:eu-west-2:824320358416:Cloudwatch_ALERT"
sub_domain         = "calendar"
hosted_zone        = "uk.prod.receptionhq.com"
alb_name           = "uk-prod-receptionhq-web-app-alb"
hosted_zone_id     = "Z05260001DTQN68P6AP8Q"
##############################################

terraform_remote_state_basestack_config = {
  region         = "ap-southeast-2"
  bucket         = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key            = "env:/prod-uk/terraform_prod_uk_basestack.tfstate"
  dynamodb_table = "tfstate-table"
}

terraform_remote_state_legacystack_config = {
  region         = "ap-southeast-2"
  bucket         = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key            = "env:/prod-uk/terraform_prod_uk_legacystack.tfstate"
  dynamodb_table = "tfstate-table"
}

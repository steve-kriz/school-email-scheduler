# NOTE: Make sure sync up the following variables with tf-basestack Repo
##############################################
project_name       = "receptionhq"
project_name_short = "rhq"
account_id         = "824320358416"
region             = "us-west-1"
environment        = "prod"
tenant             = "us"
Alert_SNS_ARN      = "arn:aws:sns:us-west-1:824320358416:Cloudwatch_ALERT"
sub_domain         = "calendar"
hosted_zone        = "us.prod.receptionhq.com"
alb_name           = "us-prod-receptionhq-web-app-alb"
hosted_zone_id     = "Z00749931KSSIZKW2JZ3N"
##############################################

terraform_remote_state_basestack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key    = "env:/prod-us/terraform_prod_us_basestack.tfstate"
}

terraform_remote_state_legacystack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key    = "env:/prod-us/terraform_prod_us_legacystack.tfstate"
}

# NOTE: Make sure sync up the following variables with tf-basestack Repo
##############################################
project_name       = "receptionhq"
project_name_short = "rhq"
account_id         = "824320358416"
region             = "ap-southeast-2"
environment        = "prod"
tenant             = "au"
Alert_SNS_ARN      = ""
sub_domain         = "calendar"
hosted_zone        = "au.prod.receptionhq.com"
alb_name           = "au-prod-receptionhq-web-app-alb"
hosted_zone_id     = "Z05260001DTQN68P6AP8Q"
##############################################

terraform_remote_state_basestack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key    = "env:/prod-au/terraform_prod_au_basestack.tfstate"
}

terraform_remote_state_legacystack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-824320358416-officehq-tfstate-bucket"
  key    = "env:/prod-au/terraform_prod_au_legacystack.tfstate"
}

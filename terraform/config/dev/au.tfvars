# NOTE: Make sure sync up the following variables with tf-basestack Repo
##############################################
project_name       = "receptionhq"
project_name_short = "rhq"
account_id         = "058264301523"
region             = "ap-southeast-2"
environment        = "dev"
tenant             = "au"
Alert_SNS_ARN      = ""
sub_domain         = "calendar"
hosted_zone        = "au.dev.receptionhq.com"
alb_name           = "au-dev-receptionhq-web-app-alb"
hosted_zone_id     = "Z01295023U1SROTEMSPWK"
##############################################

terraform_remote_state_basestack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-058264301523-officehq-tfstate-bucket"
  key    = "env:/dev-au/terraform_dev_au_basestack.tfstate"
}

terraform_remote_state_legacystack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-058264301523-officehq-tfstate-bucket"
  key    = "env:/dev-au/terraform_dev_au.tfstate"
}

# NOTE: Make sure sync up the following variables with tf-basestack Repo
#
# This is the ONLY tfvars file in this repo. TASK-051 cut the stack down to a
# single deployable environment and deleted config/prod/{au,uk,us}.tfvars along
# with their terraform_init_prod_*.sh scripts. Redeploying a prod tenant means
# recovering its account id, region and basestack state key from git history.
##############################################
project_name  = "receptionhq"
region        = "ap-southeast-2"
environment   = "dev"
tenant        = "au"
Alert_SNS_ARN = ""
##############################################

terraform_remote_state_basestack_config = {
  region = "ap-southeast-2"
  bucket = "ap-southeast-2-058264301523-officehq-tfstate-bucket"
  key    = "env:/dev-au/terraform_dev_au_basestack.tfstate"
}

# This is the ONLY tfvars file in this repo. TASK-051 cut the stack down to a
# single deployable environment and deleted config/prod/{au,uk,us}.tfvars along
# with their terraform_init_prod_*.sh scripts. Redeploying a prod tenant means
# recovering its account id and region from git history.
##############################################
project_name  = "receptionhq"
region        = "ap-southeast-2"
environment   = "dev"
tenant        = "au"
Alert_SNS_ARN = ""
##############################################

# The terraform_remote_state_basestack_config block (bucket / key / region for
# the basestack tfstate object) was removed here by TASK-052, in the same change
# as var.terraform_remote_state_basestack_config in variables.tf and
# data.terraform_remote_state.basestack in provider.tf. Nothing in this stack
# reads a basestack output any more: the Lambda's vpc_config and its security
# group were the only readers and both are gone. This stack no longer needs to
# be kept in sync with the tf-basestack repo.

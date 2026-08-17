#!/bin/bash
export TF_ENV="prod/uk"

export BUCKETNAME="824320358416-officehq-tfstate-bucket"
export AWS_REGION="ap-southeast-2"
export DDBTABLENAME="tfstate-table"
export PROFILE="ohq-prod"

TF_ENV_SHORT="prod_uk"
TF_WORKSPACE="prod-uk"
# Distinct from the chatbot's terraform_prod_uk_ohq_chatbot.tfstate so the two
# stacks never share state in the shared tfstate bucket.
TF_STATE_KEY="terraform_${TF_ENV_SHORT}_school_calendar.tfstate"

echo "Initializing variables"
echo "BUCKETNAME: $BUCKETNAME"
echo "AWS_REGION: $AWS_REGION"
echo "DDBTABLENAME: $DDBTABLENAME"

# Build the terraform init command
INIT_CMD="terraform init -upgrade -reconfigure -backend=true"
INIT_CMD="$INIT_CMD -backend-config=\"bucket=$AWS_REGION-$BUCKETNAME\""
INIT_CMD="$INIT_CMD -backend-config=\"key=$TF_STATE_KEY\""
INIT_CMD="$INIT_CMD -backend-config=\"region=$AWS_REGION\""
INIT_CMD="$INIT_CMD -backend-config=\"dynamodb_table=$AWS_REGION-$DDBTABLENAME\""

# Only include profile when NOT running in CI
# GitHub Actions sets CI=true automatically
if [ "$CI" != "true" ]; then
  echo "PROFILE: $PROFILE"
  INIT_CMD="$INIT_CMD -backend-config=\"profile=$PROFILE\""
else
  echo "Running in CI - using environment credentials (no profile)"
fi

echo "Initializing terraform"
eval $INIT_CMD

echo "Selecting workspace $TF_WORKSPACE"
terraform workspace select -or-create $TF_WORKSPACE

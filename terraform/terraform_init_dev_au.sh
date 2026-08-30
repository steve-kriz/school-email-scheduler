#!/bin/bash

export TF_ENV="dev/au"
export BUCKETNAME="058264301523-officehq-tfstate-bucket"
export AWS_REGION="ap-southeast-2"
export PROFILE="ohq-dev"

TF_ENV_SHORT="dev_au"
TF_WORKSPACE="dev-au"
# Distinct from the chatbot's terraform_dev_ohq_chatbot.tfstate so the two
# stacks never share state in the shared tfstate bucket.
TF_STATE_KEY="terraform_${TF_ENV_SHORT}_school_calendar.tfstate"

echo "Initializing variables"
echo "BUCKETNAME: $BUCKETNAME"
echo "AWS_REGION: $AWS_REGION"

# Build the terraform init command
INIT_CMD="terraform init -upgrade -reconfigure -backend=true"
INIT_CMD="$INIT_CMD -backend-config=\"bucket=$AWS_REGION-$BUCKETNAME\""
INIT_CMD="$INIT_CMD -backend-config=\"key=$TF_STATE_KEY\""
INIT_CMD="$INIT_CMD -backend-config=\"region=$AWS_REGION\""

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

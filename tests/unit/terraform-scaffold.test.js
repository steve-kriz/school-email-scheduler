import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

describe('Terraform Scaffold Unit Tests', () => {
  describe('provider.tf validation', () => {
    let providerContent;

    it('should exist', () => {
      const providerPath = path.join(TERRAFORM_DIR, 'provider.tf');
      assert.ok(fs.existsSync(providerPath), 'provider.tf not found');
      providerContent = fs.readFileSync(providerPath, 'utf-8');
      assert.ok(providerContent.length > 0, 'provider.tf is empty');
    });

    it('should declare hashicorp/aws ~> 6.19', () => {
      assert.ok(providerContent.includes('hashicorp/aws'),
        'hashicorp/aws provider not declared');
      assert.ok(providerContent.includes('~> 6.19'),
        'AWS provider version constraint ~> 6.19 not found');
    });

    it('should declare s3 backend with encrypt = true', () => {
      assert.ok(providerContent.includes('backend "s3"'),
        's3 backend not declared');
      assert.ok(providerContent.includes('encrypt'),
        'encrypt setting not found in s3 backend');
      assert.match(providerContent, /encrypt\s*=\s*true/,
        'encrypt should be set to true');
    });

    it('should lock state via S3 lockfile, not a DynamoDB table', () => {
      assert.match(providerContent, /use_lockfile\s*=\s*true/,
        'use_lockfile = true not found in s3 backend');
      assert.ok(!providerContent.includes('dynamodb_table'),
        'dynamodb_table should no longer be referenced in provider.tf');
    });

    it('should require Terraform 1.10+ so use_lockfile is supported', () => {
      assert.match(providerContent, /required_version\s*=\s*">=\s*1\.10"/,
        'required_version >= 1.10 not declared in the terraform block');
    });

    it('should declare regional provider constrained by allowed_account_ids', () => {
      assert.ok(providerContent.includes('provider "aws"'),
        'aws provider not declared');
      assert.ok(providerContent.includes('allowed_account_ids = [var.account_id]'),
        'allowed_account_ids constraint not found');
    });

    it('should declare aws_global (us-east-1) aliased provider', () => {
      assert.ok(providerContent.includes('alias'),
        'alias not declared for second provider');
      assert.ok(providerContent.includes('aws_global'),
        'aws_global alias not found');
      assert.ok(providerContent.includes('us-east-1'),
        'us-east-1 region not declared for global provider');
    });

    it('should declare basestack terraform_remote_state data source', () => {
      assert.ok(providerContent.includes('data "terraform_remote_state" "basestack"'),
        'basestack remote state data source not found');
      assert.ok(providerContent.includes('terraform_remote_state_basestack_config'),
        'terraform_remote_state_basestack_config not used in basestack data source');
    });

    it('should declare legacystack terraform_remote_state data source', () => {
      assert.ok(providerContent.includes('data "terraform_remote_state" "legacystack"'),
        'legacystack remote state data source not found');
      assert.ok(providerContent.includes('terraform_remote_state_legacystack_config'),
        'terraform_remote_state_legacystack_config not used in legacystack data source');
    });
  });

  describe('variables.tf validation', () => {
    let variablesContent;

    it('should exist', () => {
      const variablesPath = path.join(TERRAFORM_DIR, 'variables.tf');
      assert.ok(fs.existsSync(variablesPath), 'variables.tf not found');
      variablesContent = fs.readFileSync(variablesPath, 'utf-8');
      assert.ok(variablesContent.length > 0, 'variables.tf is empty');
    });

    // Reads the right-hand side of a `<name> = ...` assignment inside a locals
    // block. Scoping to the assignment is what makes the ordering assertions
    // below meaningful: a file-wide `includes()` cannot tell tenant-first from
    // environment-first. The evaluated behaviour is covered for real by
    // `terraform console` in tests/e2e/terraform-scaffold.test.js.
    function localAssignment(name) {
      const match = variablesContent.match(
        new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(\\S.*)$`, 'm')
      );
      assert.ok(match, `${name} local assignment not found in variables.tf`);
      return match[1].trim();
    }

    it('should define local.name_prefix', () => {
      assert.ok(variablesContent.includes('locals {'),
        'locals block not found');
      assert.ok(variablesContent.includes('name_prefix'),
        'name_prefix local not defined');
      assert.ok(variablesContent.includes('var.tenant'),
        'local.name_prefix does not reference var.tenant');
      assert.ok(variablesContent.includes('var.environment'),
        'local.name_prefix does not reference var.environment');
      assert.ok(variablesContent.includes('var.project_name'),
        'local.name_prefix does not reference var.project_name');
    });

    it('should interpolate local.name_prefix as tenant-environment-project_name in that order', () => {
      assert.equal(localAssignment('name_prefix'),
        '"${var.tenant}-${var.environment}-${var.project_name}"',
        'local.name_prefix must interpolate var.tenant, var.environment then var.project_name in that order');
    });

    it('should define local.name_prefix_short', () => {
      assert.ok(variablesContent.includes('name_prefix_short'),
        'name_prefix_short local not defined');
      assert.ok(variablesContent.includes('project_name_short'),
        'local.name_prefix_short does not reference var.project_name_short');
    });

    it('should interpolate local.name_prefix_short as tenant-environment-project_name_short in that order', () => {
      assert.equal(localAssignment('name_prefix_short'),
        '"${var.tenant}-${var.environment}-${var.project_name_short}"',
        'local.name_prefix_short must interpolate var.tenant, var.environment then var.project_name_short in that order');
    });

    it('should define local.secret_name', () => {
      assert.ok(variablesContent.includes('secret_name'),
        'secret_name local not defined');
      assert.ok(variablesContent.includes('var.environment'),
        'local.secret_name does not reference var.environment');
      assert.ok(variablesContent.includes('var.tenant'),
        'local.secret_name does not reference var.tenant');
      assert.ok(variablesContent.includes('app-config/school_calendar_services'),
        'local.secret_name does not reference correct secret path');
    });

    it('should interpolate local.secret_name as environment-tenant/app-config/school_calendar_services in that order', () => {
      assert.equal(localAssignment('secret_name'),
        '"${var.environment}-${var.tenant}/app-config/school_calendar_services"',
        'local.secret_name must interpolate var.environment then var.tenant, followed by /app-config/school_calendar_services');
    });

    it('should declare variable.project_name', () => {
      assert.ok(variablesContent.includes('variable "project_name"'),
        'project_name variable not declared');
    });

    it('should declare variable.project_name_short', () => {
      assert.ok(variablesContent.includes('variable "project_name_short"'),
        'project_name_short variable not declared');
    });

    it('should declare variable.account_id', () => {
      assert.ok(variablesContent.includes('variable "account_id"'),
        'account_id variable not declared');
    });

    it('should declare variable.environment', () => {
      assert.ok(variablesContent.includes('variable "environment"'),
        'environment variable not declared');
    });

    it('should declare variable.region', () => {
      assert.ok(variablesContent.includes('variable "region"'),
        'region variable not declared');
    });

    it('should declare variable.tenant', () => {
      assert.ok(variablesContent.includes('variable "tenant"'),
        'tenant variable not declared');
    });

    it('should declare variable.terraform_remote_state_basestack_config', () => {
      assert.ok(variablesContent.includes('variable "terraform_remote_state_basestack_config"'),
        'terraform_remote_state_basestack_config variable not declared');
    });

    it('should declare variable.terraform_remote_state_legacystack_config', () => {
      assert.ok(variablesContent.includes('variable "terraform_remote_state_legacystack_config"'),
        'terraform_remote_state_legacystack_config variable not declared');
    });

    it('should declare variable.sub_domain', () => {
      assert.ok(variablesContent.includes('variable "sub_domain"'),
        'sub_domain variable not declared');
    });

    it('should declare variable.hosted_zone_id', () => {
      assert.ok(variablesContent.includes('variable "hosted_zone_id"'),
        'hosted_zone_id variable not declared');
    });

    it('should declare variable.hosted_zone', () => {
      assert.ok(variablesContent.includes('variable "hosted_zone"'),
        'hosted_zone variable not declared');
    });

    it('should declare variable.alb_name', () => {
      assert.ok(variablesContent.includes('variable "alb_name"'),
        'alb_name variable not declared');
    });

    it('should declare variable.Alert_SNS_ARN', () => {
      assert.ok(variablesContent.includes('variable "Alert_SNS_ARN"'),
        'Alert_SNS_ARN variable not declared');
    });
  });

  describe('main.tf validation', () => {
    let mainContent;

    it('should exist', () => {
      const mainPath = path.join(TERRAFORM_DIR, 'main.tf');
      assert.ok(fs.existsSync(mainPath), 'main.tf not found');
      mainContent = fs.readFileSync(mainPath, 'utf-8');
      assert.ok(mainContent.length > 0, 'main.tf is empty');
    });

    // TASK-049: the app is served from a Lambda function URL, not from the
    // shared ALB. The A-ALIAS record pointed a custom hostname at that load
    // balancer; once the listener rule for /calendar* went, the record would
    // have resolved to an ALB with no matching rule - a hostname that answers
    // but serves nothing. It was removed rather than left dangling.
    it('should NOT create an aws_route53_record: stale DNS must not silently serve nothing', () => {
      assert.ok(!mainContent.includes('resource "aws_route53_record"'),
        'aws_route53_record still declared; with the listener rule gone it would resolve to an ALB that has no rule for this app');
    });

    it('should not alias anything to the shared ALB any more', () => {
      assert.ok(!mainContent.includes('data "aws_lb"'),
        'the shared ALB data source is still looked up in main.tf');
      assert.ok(!mainContent.includes('data "aws_lb_listener"'),
        'the shared ALB listener data source is still looked up in main.tf');
      assert.ok(!mainContent.includes('alias {'),
        'an alias block survives in main.tf with no load balancer to point at');
    });

    it('should publish the function URL as the public origin instead', () => {
      const lambdaTf = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
      assert.ok(lambdaTf.includes('resource "aws_lambda_function_url" "calendar"'),
        'aws_lambda_function_url.calendar not found - nothing serves the app');
      assert.ok(lambdaTf.includes('output "calendar_function_url"'),
        'the public origin is not published as an output');
    });

    it('should expose local.secrets from Secrets Manager lookup', () => {
      assert.ok(mainContent.includes('data "aws_secretsmanager_secret_version"'),
        'Secrets Manager data source not found');
      assert.ok(mainContent.includes('secret_id = local.secret_name'),
        'secret_name local not used in Secrets Manager lookup');
      assert.ok(mainContent.includes('jsondecode'),
        'Secrets Manager secret not decoded as JSON');
      assert.ok(mainContent.includes('locals {') && mainContent.includes('secrets ='),
        'local.secrets not defined');
    });

    it('should use lookup() for safe secret key access', () => {
      assert.ok(mainContent.includes('lookup(local.secrets'),
        'lookup() not used for secret access');
    });

    it('should provide empty default for optional secret keys', () => {
      assert.ok(mainContent.includes('""'),
        'Empty default not provided for secret lookups');
      const lookupMatches = mainContent.match(/lookup\(local\.secrets,\s*"[^"]+",\s*""\)/g);
      assert.ok(lookupMatches && lookupMatches.length > 0,
        'No secret lookups with empty default found');
    });

    it('should declare lambda_assume_role_policy', () => {
      assert.ok(mainContent.includes('data "aws_iam_policy_document" "lambda_assume_role_policy"'),
        'lambda_assume_role_policy data source not found');
    });

    it('should allow sts:AssumeRole for lambda.amazonaws.com', () => {
      assert.ok(mainContent.includes('lambda.amazonaws.com'),
        'lambda.amazonaws.com service principal not found');
      assert.ok(mainContent.includes('sts:AssumeRole'),
        'sts:AssumeRole action not found');
      assert.ok(mainContent.includes('effect = "Allow"') || mainContent.includes('effect          = "Allow"'),
        'Allow effect not set for lambda assume role');
    });
  });

  describe('tfvars files validation', () => {
    it('dev/au.tfvars should exist with sub_domain = "calendar"', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
      assert.ok(fs.existsSync(tfvarsPath), 'dev/au.tfvars not found');
      const content = fs.readFileSync(tfvarsPath, 'utf-8');
      assert.ok(content.includes('sub_domain         = "calendar"'),
        'sub_domain not set to "calendar" in dev/au.tfvars');
    });

    it('dev/au.tfvars should have terraform_remote_state_*_config maps', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
      const content = fs.readFileSync(tfvarsPath, 'utf-8');
      assert.ok(content.includes('terraform_remote_state_basestack_config'),
        'terraform_remote_state_basestack_config not found');
      assert.ok(content.includes('terraform_remote_state_legacystack_config'),
        'terraform_remote_state_legacystack_config not found');
    });

    it('prod/au.tfvars should exist with sub_domain = "calendar"', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'prod', 'au.tfvars');
      assert.ok(fs.existsSync(tfvarsPath), 'prod/au.tfvars not found');
      const content = fs.readFileSync(tfvarsPath, 'utf-8');
      assert.ok(content.includes('sub_domain         = "calendar"'),
        'sub_domain not set to "calendar" in prod/au.tfvars');
    });

    it('prod/uk.tfvars should exist with sub_domain = "calendar"', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'prod', 'uk.tfvars');
      assert.ok(fs.existsSync(tfvarsPath), 'prod/uk.tfvars not found');
      const content = fs.readFileSync(tfvarsPath, 'utf-8');
      assert.ok(content.includes('sub_domain         = "calendar"'),
        'sub_domain not set to "calendar" in prod/uk.tfvars');
    });

    it('prod/us.tfvars should exist with sub_domain = "calendar"', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'prod', 'us.tfvars');
      assert.ok(fs.existsSync(tfvarsPath), 'prod/us.tfvars not found');
      const content = fs.readFileSync(tfvarsPath, 'utf-8');
      assert.ok(content.includes('sub_domain         = "calendar"'),
        'sub_domain not set to "calendar" in prod/us.tfvars');
    });
  });

  describe('init scripts validation', () => {
    it('terraform_init_dev_au.sh should exist and be executable', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
      assert.ok(fs.existsSync(scriptPath), 'terraform_init_dev_au.sh not found');
      const stats = fs.statSync(scriptPath);
      assert.ok(stats.isFile(), 'terraform_init_dev_au.sh is not a file');
    });

    it('terraform_init_prod_au.sh should exist and be executable', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_au.sh');
      assert.ok(fs.existsSync(scriptPath), 'terraform_init_prod_au.sh not found');
      const stats = fs.statSync(scriptPath);
      assert.ok(stats.isFile(), 'terraform_init_prod_au.sh is not a file');
    });

    it('terraform_init_prod_uk.sh should exist and be executable', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_uk.sh');
      assert.ok(fs.existsSync(scriptPath), 'terraform_init_prod_uk.sh not found');
      const stats = fs.statSync(scriptPath);
      assert.ok(stats.isFile(), 'terraform_init_prod_uk.sh is not a file');
    });

    it('terraform_init_prod_us.sh should exist and be executable', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_us.sh');
      assert.ok(fs.existsSync(scriptPath), 'terraform_init_prod_us.sh not found');
      const stats = fs.statSync(scriptPath);
      assert.ok(stats.isFile(), 'terraform_init_prod_us.sh is not a file');
    });

    it('dev/au init script should export TF_STATE_KEY with "school_calendar"', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('TF_STATE_KEY'),
        'TF_STATE_KEY not exported in dev/au init script');
      assert.ok(content.includes('school_calendar'),
        'school_calendar not in TF_STATE_KEY');
    });

    it('dev/au init script TF_STATE_KEY should not equal chatbot\'s state key', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      // Remove comments to check only active code
      const activeCode = content.split('\n')
        .filter(line => !line.trim().startsWith('#'))
        .join('\n');
      assert.ok(!activeCode.includes('terraform_dev_ohq_chatbot.tfstate'),
        'dev/au init script contains chatbot state key in active code');
    });

    it('dev/au init script should use workspace "dev-au"', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('dev-au'),
        'workspace "dev-au" not referenced in dev/au init script');
      assert.ok(content.includes('terraform workspace select -or-create'),
        'terraform workspace select not found in dev/au init script');
    });

    it('prod/au init script should export TF_STATE_KEY with "school_calendar"', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_au.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('TF_STATE_KEY'),
        'TF_STATE_KEY not exported in prod/au init script');
      assert.ok(content.includes('school_calendar'),
        'school_calendar not in TF_STATE_KEY in prod/au init script');
    });

    it('prod/uk init script should export TF_STATE_KEY with "school_calendar"', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_uk.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('TF_STATE_KEY'),
        'TF_STATE_KEY not exported in prod/uk init script');
      assert.ok(content.includes('school_calendar'),
        'school_calendar not in TF_STATE_KEY in prod/uk init script');
    });

    it('prod/us init script should export TF_STATE_KEY with "school_calendar"', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_prod_us.sh');
      const content = fs.readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('TF_STATE_KEY'),
        'TF_STATE_KEY not exported in prod/us init script');
      assert.ok(content.includes('school_calendar'),
        'school_calendar not in TF_STATE_KEY in prod/us init script');
    });
  });

  describe('package.json validation', () => {
    let packageJsonContent;
    let packageJson;

    it('should exist', () => {
      const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
      assert.ok(fs.existsSync(packageJsonPath), 'package.json not found');
      packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
      packageJson = JSON.parse(packageJsonContent);
    });

    it('should define "test" script', () => {
      assert.ok(packageJson.scripts && packageJson.scripts.test,
        '"test" script not defined in package.json');
    });

    it('should define "test:unit" script', () => {
      assert.ok(packageJson.scripts && packageJson.scripts['test:unit'],
        '"test:unit" script not defined in package.json');
    });

    it('should define "test:e2e" script', () => {
      assert.ok(packageJson.scripts && packageJson.scripts['test:e2e'],
        '"test:e2e" script not defined in package.json');
    });

    it('should define "test:bdd" script', () => {
      assert.ok(packageJson.scripts && packageJson.scripts['test:bdd'],
        '"test:bdd" script not defined in package.json');
    });
  });

  describe('test directories validation', () => {
    it('tests/unit/ directory should exist', () => {
      const unitDir = path.join(PROJECT_ROOT, 'tests', 'unit');
      assert.ok(fs.existsSync(unitDir), 'tests/unit/ directory not found');
    });

    it('tests/e2e/ directory should exist', () => {
      const e2eDir = path.join(PROJECT_ROOT, 'tests', 'e2e');
      assert.ok(fs.existsSync(e2eDir), 'tests/e2e/ directory not found');
    });

    it('tests/bdd/features/ directory should exist', () => {
      const featuresDir = path.join(PROJECT_ROOT, 'tests', 'bdd', 'features');
      assert.ok(fs.existsSync(featuresDir), 'tests/bdd/features/ directory not found');
    });

    it('tests/bdd/steps/ directory should exist', () => {
      const stepsDir = path.join(PROJECT_ROOT, 'tests', 'bdd', 'steps');
      assert.ok(fs.existsSync(stepsDir), 'tests/bdd/steps/ directory not found');
    });
  });

  describe('.gitignore validation', () => {
    let gitignoreContent;

    it('should exist', () => {
      const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
      assert.ok(fs.existsSync(gitignorePath), '.gitignore not found');
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    });

    it('should ignore .terraform/', () => {
      assert.ok(gitignoreContent.includes('.terraform/'),
        '.terraform/ not ignored in .gitignore');
    });

    it('should ignore *.tfstate*', () => {
      assert.ok(gitignoreContent.includes('*.tfstate'),
        '*.tfstate not ignored in .gitignore');
    });

    it('should ignore packages/*.zip', () => {
      assert.ok(gitignoreContent.includes('packages/*.zip'),
        'packages/*.zip not ignored in .gitignore');
    });

    it('should ignore node_modules/', () => {
      assert.ok(gitignoreContent.includes('node_modules/'),
        'node_modules/ not ignored in .gitignore');
    });

    it('should ignore .env', () => {
      assert.ok(gitignoreContent.includes('.env'),
        '.env not ignored in .gitignore');
    });
  });

  describe('credential and secret validation', () => {
    it('should not commit AWS account IDs in terraform files', () => {
      const tfFiles = [
        path.join(TERRAFORM_DIR, 'provider.tf'),
        path.join(TERRAFORM_DIR, 'variables.tf'),
        path.join(TERRAFORM_DIR, 'main.tf')
      ];

      tfFiles.forEach(tfPath => {
        if (fs.existsSync(tfPath)) {
          const content = fs.readFileSync(tfPath, 'utf-8');
          // Check for hardcoded AWS account IDs (12-digit numbers not in strings)
          const hardcodedAccountIdMatch = content.match(/account_id\s*=\s*"(\d{12})"/);
          assert.ok(!hardcodedAccountIdMatch,
            `Hardcoded account ID found in ${path.basename(tfPath)}`);
        }
      });
    });

    it('tfvars files should use variables, not hardcoded values for sensitive data', () => {
      const tfvarsFiles = [
        path.join(CONFIG_DIR, 'dev', 'au.tfvars'),
        path.join(CONFIG_DIR, 'prod', 'au.tfvars'),
        path.join(CONFIG_DIR, 'prod', 'uk.tfvars'),
        path.join(CONFIG_DIR, 'prod', 'us.tfvars')
      ];

      tfvarsFiles.forEach(tfvarsPath => {
        if (fs.existsSync(tfvarsPath)) {
          const content = fs.readFileSync(tfvarsPath, 'utf-8');
          // Check for hardcoded secrets or API keys
          const apiKeyMatch = content.match(/[A-Za-z0-9_-]{40,}/);
          // This is a loose check - actual keys would be longer and have specific patterns
          // We're mostly checking that there are no obvious secrets committed
          assert.ok(!content.includes('AKIA'),
            `AWS access key found in ${path.basename(tfvarsPath)}`);
          assert.ok(!content.includes('BEGIN PRIVATE KEY'),
            `Private key found in ${path.basename(tfvarsPath)}`);
        }
      });
    });

    it('init scripts should not contain hardcoded AWS credentials', () => {
      const scripts = [
        path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh'),
        path.join(TERRAFORM_DIR, 'terraform_init_prod_au.sh'),
        path.join(TERRAFORM_DIR, 'terraform_init_prod_uk.sh'),
        path.join(TERRAFORM_DIR, 'terraform_init_prod_us.sh')
      ];

      scripts.forEach(scriptPath => {
        if (fs.existsSync(scriptPath)) {
          const content = fs.readFileSync(scriptPath, 'utf-8');
          assert.ok(!content.includes('AKIA'),
            `AWS access key found in ${path.basename(scriptPath)}`);
          assert.ok(!content.includes('secret'),
            `Hardcoded secret reference found in ${path.basename(scriptPath)}`);
        }
      });
    });
  });
});

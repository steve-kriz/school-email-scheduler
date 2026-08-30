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

/**
 * Drop every `#` / `//` comment line from HCL text. TASK-051 left long
 * explanatory comments naming the things it removed (var.account_id,
 * allowed_account_ids, legacystack, aws_global). A plain `includes()` over the
 * raw file would see those names and conclude the code is still there, so the
 * "is it gone?" assertions must look at code only.
 */
function stripHclComments(content) {
  return content
    .split('\n')
    .filter(line => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

/** The inverse: only the comment text, for asserting a removal is documented. */
function hclCommentText(content) {
  return content
    .split('\n')
    .filter(line => /^\s*(#|\/\/)/.test(line))
    .join('\n');
}

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

    // TASK-051 removed the allowed_account_ids wrong-account guard along with
    // var.account_id. That is an accepted, informed regression, NOT an
    // oversight, so what is asserted now is (a) the argument really is gone and
    // (b) a comment says so - a silent removal would leave the next reader
    // unable to tell a deliberate drop from a botched refactor.
    it('should declare exactly one regional aws provider with no allowed_account_ids argument', () => {
      assert.ok(providerContent.includes('provider "aws"'),
        'aws provider not declared');

      const providerBlocks = providerContent.match(/^provider\s+"aws"\s*\{/gm) || [];
      assert.equal(providerBlocks.length, 1,
        `expected exactly one provider "aws" block, found ${providerBlocks.length}`);

      const uncommented = stripHclComments(providerContent);
      assert.ok(!uncommented.includes('allowed_account_ids'),
        'allowed_account_ids is still an active argument; TASK-051 removed it');
      assert.ok(!uncommented.includes('var.account_id'),
        'provider.tf still references var.account_id, which no longer exists');
    });

    it('should document the dropped account-mismatch guard rather than leave it silently missing', () => {
      const comments = hclCommentText(providerContent);
      assert.ok(comments.includes('allowed_account_ids'),
        'no comment in provider.tf mentions allowed_account_ids; the dropped guard is silently missing');
      assert.match(comments, /deliberate|deliberately|accepted|informed regression/i,
        'the allowed_account_ids comment does not state the removal was deliberate');
    });

    it('should NOT declare an aws_global (us-east-1) aliased provider', () => {
      const uncommented = stripHclComments(providerContent);
      assert.ok(!uncommented.includes('aws_global'),
        'the aws_global provider alias survives, but no resource ever set provider = aws.aws_global');
      assert.ok(!/^\s*alias\s*=/m.test(uncommented),
        'a provider alias is still declared in provider.tf');
      assert.ok(!uncommented.includes('us-east-1'),
        'us-east-1 is still hardcoded in provider.tf; the global provider was removed');
    });

    // INVERTED BY TASK-052 (was: "should declare basestack terraform_remote_state
    // data source"). TASK-052 removed the Lambda's vpc_config and
    // aws_security_group.calendar_sg - the only two readers of the basestack
    // state's private_subnet_ids and vpc_id outputs - and deleted the data
    // source, its variable and its tfvars key in the same change. This stack now
    // reads NO remote state at all, so the assertion is the exact inverse.
    it('should NOT declare a basestack terraform_remote_state data source', () => {
      const uncommented = stripHclComments(providerContent);
      assert.ok(!uncommented.includes('data "terraform_remote_state" "basestack"'),
        'basestack remote state data source still declared; TASK-052 removed its last reader');
      assert.ok(!uncommented.includes('terraform_remote_state_basestack_config'),
        'terraform_remote_state_basestack_config still referenced in provider.tf');
    });

    it('should declare no terraform_remote_state data source of any name', () => {
      const uncommented = stripHclComments(providerContent);
      assert.ok(!/data\s+"terraform_remote_state"/.test(uncommented),
        'provider.tf still declares a terraform_remote_state data source; this stack reads no remote state');
    });

    it('should NOT declare a legacystack terraform_remote_state data source', () => {
      const uncommented = stripHclComments(providerContent);
      assert.ok(!uncommented.includes('data "terraform_remote_state" "legacystack"'),
        'legacystack remote state data source still declared; nothing ever read an output from it');
      assert.ok(!uncommented.includes('terraform_remote_state_legacystack_config'),
        'terraform_remote_state_legacystack_config still referenced in provider.tf');
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

    // TASK-051 removed local.name_prefix_short and var.project_name_short. Its
    // only consumer was the ALB target group's 32-char-capped name, which
    // TASK-049 deleted with the rest of the ALB ingress. local.name_prefix is
    // NOT affected - it is asserted byte-for-byte above and must not drift.
    it('should NOT define local.name_prefix_short any more', () => {
      const code = stripHclComments(variablesContent);
      assert.ok(!code.includes('name_prefix_short'),
        'local.name_prefix_short is still defined, but the ALB target group it named is gone');
      assert.ok(!code.includes('project_name_short'),
        'var.project_name_short is still referenced in variables.tf');
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

    // INVERTED BY TASK-052 (was: "should declare
    // variable.terraform_remote_state_basestack_config"). The declaration went
    // with data.terraform_remote_state.basestack and the tfvars key, in one
    // change - a declaration with no default and no value is a hard error, so
    // the two sides had to move together.
    it('should NOT declare variable.terraform_remote_state_basestack_config', () => {
      assert.ok(!/^\s*variable\s+"terraform_remote_state_basestack_config"/m
        .test(stripHclComments(variablesContent)),
      'variable "terraform_remote_state_basestack_config" is still declared, but nothing sets or reads it');
    });

    it('should declare variable.Alert_SNS_ARN', () => {
      assert.ok(variablesContent.includes('variable "Alert_SNS_ARN"'),
        'Alert_SNS_ARN variable not declared');
    });

    // TASK-051 deleted these ten declarations. A declaration with no default
    // and no tfvars value is a hard `No value for required variable` error, and
    // a `var.X` reference to an undeclared variable is a hard `Reference to
    // undeclared input variable` error - so declaration and reference had to
    // move together, and that is exactly what is asserted here.
    const REMOVED_VARIABLES = [
      'sub_domain',
      'hosted_zone',
      'hosted_zone_id',
      'alb_name',
      'project_name_short',
      'timezone',
      'geo_id',
      'language',
      'account_id',
      'terraform_remote_state_legacystack_config'
    ];

    REMOVED_VARIABLES.forEach(name => {
      it(`should NOT declare variable.${name} any more`, () => {
        assert.ok(!new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesContent),
          `variable "${name}" is still declared in variables.tf; TASK-051 removed it`);
      });
    });

    it('should leave zero var.X references to any removed variable in any .tf file', () => {
      const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf'));
      assert.ok(tfFiles.length > 0, 'no .tf files found to scan');

      const offenders = [];
      tfFiles.forEach(file => {
        const code = stripHclComments(fs.readFileSync(path.join(TERRAFORM_DIR, file), 'utf-8'));
        REMOVED_VARIABLES.forEach(name => {
          // \b on the right stops var.hosted_zone matching var.hosted_zone_id
          // (and vice versa) and reporting a phantom offender.
          if (new RegExp(`var\\.${name}\\b`).test(code)) {
            offenders.push(`${file} -> var.${name}`);
          }
        });
      });

      assert.deepEqual(offenders, [],
        `these .tf files still reference removed variables, which terraform rejects as ` +
        `"Reference to undeclared input variable": ${offenders.join(', ')}`);
    });

    it('should keep every still-needed variable declared', () => {
      const KEPT_VARIABLES = [
        'region', 'environment', 'tenant', 'project_name', 'Alert_SNS_ARN', 'tags',
        'manage_lambda_log_groups', 'calendar_log_level', 'anthropic_model',
        // terraform_remote_state_basestack_config was in this list until
        // TASK-052 deleted the declaration along with its data source and
        // tfvars key; it is asserted absent above instead.
        'public_base_url'
      ];
      KEPT_VARIABLES.forEach(name => {
        assert.ok(new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesContent),
          `variable "${name}" must still be declared, but is missing from variables.tf`);
      });
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
    it('dev/au.tfvars should exist and be the only tfvars file in the repo', () => {
      const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
      assert.ok(fs.existsSync(tfvarsPath), 'dev/au.tfvars not found');

      const found = [];
      const walk = dir => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.tfvars')) found.push(path.relative(CONFIG_DIR, full).replace(/\\/g, '/'));
        });
      };
      walk(CONFIG_DIR);

      assert.deepEqual(found.sort(), ['dev/au.tfvars'],
        `terraform/config/ should contain exactly one tfvars file after TASK-051, found: ${found.join(', ')}`);
    });

    it('dev/au.tfvars should no longer assign any removed key', () => {
      // sub_domain used to be asserted as "calendar" here. Its variable is gone,
      // and an orphaned tfvars key produces a "Value for undeclared variable"
      // warning, so the key had to go with the declaration.
      const content = fs.readFileSync(path.join(CONFIG_DIR, 'dev', 'au.tfvars'), 'utf-8');
      const code = stripHclComments(content);
      ['sub_domain', 'hosted_zone', 'hosted_zone_id', 'alb_name', 'project_name_short',
        'timezone', 'geo_id', 'language', 'account_id',
        'terraform_remote_state_legacystack_config',
        // Added by TASK-052: removed together with its variable declaration.
        'terraform_remote_state_basestack_config'].forEach(key => {
        assert.ok(!new RegExp(`^\\s*${key}\\s*=`, 'm').test(code),
          `dev/au.tfvars still assigns "${key}", whose variable declaration was removed - ` +
          'terraform would warn "Value for undeclared variable"');
      });
    });

    // INVERTED BY TASK-052 (was: "dev/au.tfvars should keep the basestack remote
    // state map with bucket, key and region", whose failure message claimed "the
    // Lambda would lose its VPC wiring"). The Lambda no longer HAS VPC wiring -
    // TASK-052 removed vpc_config, aws_security_group.calendar_sg, the data
    // source and the variable - so the map is dead config and its bucket/key/
    // region values must be gone, not merely non-empty.
    it('dev/au.tfvars should no longer carry the basestack remote state map', () => {
      const content = fs.readFileSync(path.join(CONFIG_DIR, 'dev', 'au.tfvars'), 'utf-8');
      const code = stripHclComments(content);
      assert.ok(!code.includes('terraform_remote_state_basestack_config'),
        'terraform_remote_state_basestack_config is still assigned in dev/au.tfvars, but its ' +
        'variable declaration was removed - terraform would warn "Value for undeclared variable"');
      assert.ok(!/officehq-tfstate-bucket/.test(code),
        'the basestack tfstate bucket is still named in dev/au.tfvars');
      assert.ok(!/terraform_dev_au_basestack\.tfstate/.test(code),
        'the basestack tfstate object key is still named in dev/au.tfvars');
    });

    it('terraform/config/prod/ should not exist at all', () => {
      const prodDir = path.join(CONFIG_DIR, 'prod');
      assert.ok(!fs.existsSync(prodDir),
        'terraform/config/prod/ still exists; TASK-051 removed prod as a deployable environment');
      ['au', 'uk', 'us'].forEach(tenant => {
        assert.ok(!fs.existsSync(path.join(prodDir, `${tenant}.tfvars`)),
          `terraform/config/prod/${tenant}.tfvars still exists`);
      });
    });
  });

  describe('init scripts validation', () => {
    it('terraform_init_dev_au.sh should exist and be executable', () => {
      const scriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
      assert.ok(fs.existsSync(scriptPath), 'terraform_init_dev_au.sh not found');
      const stats = fs.statSync(scriptPath);
      assert.ok(stats.isFile(), 'terraform_init_dev_au.sh is not a file');
    });

    // The three prod init scripts were deleted by TASK-051 - with their tfvars
    // gone, running one would fail at plan time on missing required variables.
    ['au', 'uk', 'us'].forEach(tenant => {
      it(`terraform_init_prod_${tenant}.sh should NOT exist any more`, () => {
        const scriptPath = path.join(TERRAFORM_DIR, `terraform_init_prod_${tenant}.sh`);
        assert.ok(!fs.existsSync(scriptPath),
          `terraform_init_prod_${tenant}.sh still exists, but its config/prod/${tenant}.tfvars is gone`);
      });
    });

    it('terraform_init_dev_au.sh should be the only init script left', () => {
      const scripts = fs.readdirSync(TERRAFORM_DIR)
        .filter(f => /^terraform_init_.*\.sh$/.test(f))
        .sort();
      assert.deepEqual(scripts, ['terraform_init_dev_au.sh'],
        `expected exactly one init script after TASK-051, found: ${scripts.join(', ')}`);
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

    it('the surviving dev/au init script should not reference a removed prod tenant', () => {
      const content = fs.readFileSync(path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh'), 'utf-8');
      const activeCode = content.split('\n')
        .filter(line => !line.trim().startsWith('#'))
        .join('\n');
      ['prod-au', 'prod-uk', 'prod-us', 'prod_au', 'prod_uk', 'prod_us'].forEach(token => {
        assert.ok(!activeCode.includes(token),
          `terraform_init_dev_au.sh's active code mentions "${token}", a tenant that can no longer be deployed`);
      });
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
      // dev/au is the only tfvars file left after TASK-051.
      const tfvarsFiles = [
        path.join(CONFIG_DIR, 'dev', 'au.tfvars')
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
      // dev/au is the only init script left after TASK-051.
      const scripts = [
        path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh')
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

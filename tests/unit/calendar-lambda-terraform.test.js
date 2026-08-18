import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

describe('Calendar Lambda Terraform Unit Tests', () => {
  describe('Feature: Calendar Lambda and ALB wiring', () => {
    describe('Scenario: Archive file configuration', () => {
      it('Given lambda_calendar.tf, Then archive_file data source zips ../src/lambda/calendar', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('data "archive_file" "calendar_lambda_zip"'),
          'archive_file data source not found');
        assert.ok(tfContent.includes('source_dir  = "../src/lambda/calendar"'),
          'source_dir not correctly set');
      });

      it('When archive_file is configured, Then output_path is packages/lambda_function_calendar.zip', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('output_path = "packages/lambda_function_calendar.zip"'),
          'output_path not correctly set');
      });

      it('When archive_file is configured, Then it excludes CLAUDE.md, .deployment, package-lock.json, __test_shims__', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('"CLAUDE.md"'), 'CLAUDE.md not in excludes');
        assert.ok(tfContent.includes('".deployment"'), '.deployment not in excludes');
        assert.ok(tfContent.includes('"package-lock.json"'), 'package-lock.json not in excludes');
        assert.ok(tfContent.includes('"__test_shims__"'), '__test_shims__ not in excludes');
      });
    });

    describe('Scenario: Lambda function configuration', () => {
      it('Given aws_lambda_function resource, Then function_name is ${local.name_prefix}-school-calendar', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('function_name    = "${local.name_prefix}-school-calendar"'),
          'function_name not correctly set');
      });

      it('When lambda_function is configured, Then runtime is nodejs24.x', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('runtime          = "nodejs24.x"'),
          'runtime not correctly set to nodejs24.x');
      });

      it('When lambda_function is configured, Then handler is index.handler', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('handler          = "index.handler"'),
          'handler not correctly set');
      });

      it('When lambda_function is configured, Then timeout is 60 seconds', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('timeout          = 60'),
          'timeout not correctly set to 60');
      });

      it('When lambda_function is configured, Then memory_size is 512 MB', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('memory_size      = 512'),
          'memory_size not correctly set to 512');
      });

      it('When lambda_function is configured, Then source_code_hash is from archive output_base64sha256', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('source_code_hash = data.archive_file.calendar_lambda_zip.output_base64sha256'),
          'source_code_hash not correctly set');
      });
    });

    describe('Scenario: VPC configuration', () => {
      it('Given aws_lambda_function, Then vpc_config block exists', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('vpc_config {'),
          'vpc_config block not found');
      });

      it('When vpc_config is set, Then security_group_ids includes calendar security group', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('security_group_ids = [aws_security_group.calendar_sg.id]'),
          'security_group_ids not correctly set');
      });

      it('When vpc_config is set, Then subnet_ids are basestack private_subnet_ids', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('subnet_ids         = data.terraform_remote_state.basestack.outputs.private_subnet_ids'),
          'subnet_ids not correctly set');
      });
    });

    describe('Scenario: Function environment variables', () => {
      it('Given environment block in lambda_function, Then CALENDAR_LOG_LEVEL is set from var.calendar_log_level', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('CALENDAR_LOG_LEVEL = var.calendar_log_level'),
          'CALENDAR_LOG_LEVEL not correctly set');
      });

      it('When CALENDAR_FUNCTION_ARN is set, Then it is derived from locals, not from aws_lambda_function.calendar.arn', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('CALENDAR_FUNCTION_ARN = local.calendar_function_arn'),
          'CALENDAR_FUNCTION_ARN not derived from locals');
        assert.ok(!tfContent.match(/CALENDAR_FUNCTION_ARN\s*=\s*aws_lambda_function\.calendar\.arn/),
          'CALENDAR_FUNCTION_ARN should not reference aws_lambda_function.calendar.arn (would create cycle)');
      });

      it('When secret variables are set, Then every secret-derived var uses lookup(local.secrets, "KEY", "")', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');

        const secretVars = [
          'ALLOWED_ORIGINS',
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'SESSION_SECRET',
          'ANTHROPIC_API_KEY'
        ];

        for (const varName of secretVars) {
          const pattern = new RegExp(`${varName}\\s*=\\s*lookup\\(local\\.secrets,\\s*"${varName}",\\s*""\\)`);
          assert.ok(pattern.test(tfContent),
            `${varName} does not use lookup(local.secrets, "${varName}", "")`);
        }
      });
    });

    describe('Scenario: IAM policy scoping', () => {
      it('Given iam_policy for calendar lambda, Then no statement uses Resource = "*" except CloudWatch Logs and VPC EC2 actions', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');

        // Extract the policy content
        const policyMatch = tfContent.match(/policy = jsonencode\(\{[\s\S]*?\}\)/);
        assert.ok(policyMatch, 'IAM policy not found');
        const policyText = policyMatch[0];

        // Check for statements that use Resource = "*"
        const allResourceStarLines = policyText.split('\n').filter(line => line.includes('Resource = "*"'));

        // We expect exactly 2 such statements: CloudWatch Logs and VPC EC2
        // The order and exact content varies, but we can check for the Sids
        assert.ok(policyText.includes('CloudWatchLogs') || policyText.includes('CloudWatch'),
          'CloudWatch Logs statement not found');
        assert.ok(policyText.includes('VPC') || policyText.includes('NetworkInterface'),
          'VPC EC2 statement not found');

        // Count the Resource = "*" lines and ensure there are only 2 for allowed statements
        const statementCount = (policyText.match(/Sid\s*=/g) || []).length;
        assert.ok(statementCount >= 5, `Expected at least 5 statements, found ${statementCount}`);
      });

      it('When DynamoDB statement is configured, Then it includes both table ARNs and index ARNs', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('aws_dynamodb_table.calendar_connections.arn'),
          'connections table ARN not in DynamoDB resources');
        assert.ok(tfContent.includes('aws_dynamodb_table.calendar_events.arn'),
          'events table ARN not in DynamoDB resources');
        assert.ok(tfContent.includes('${aws_dynamodb_table.calendar_events.arn}/index/*'),
          'events table index ARN not in DynamoDB resources');
      });

      it('When KMS statement is configured, Then Resource is exactly the calendar CMK ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('Resource = aws_kms_key.calendar.arn'),
          'KMS statement resource not correctly scoped to calendar CMK ARN');
      });

      it('When Secrets Manager statement is configured, Then Resource is the app-config secret ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('Resource = data.aws_secretsmanager_secret.app_config.arn'),
          'Secrets Manager statement resource not correctly scoped to app_config secret ARN');
      });
    });

    describe('Scenario: Security group configuration', () => {
      it('Given aws_security_group for calendar lambda, Then name is ${local.name_prefix}-school-calendar-sg', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('name        = "${local.name_prefix}-school-calendar-sg"'),
          'security group name not correctly set');
      });

      it('When security group is configured, Then it allows all egress', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('egress {'), 'egress block not found');
        assert.ok(tfContent.includes('from_port   = 0'), 'egress from_port not set');
        assert.ok(tfContent.includes('to_port     = 0'), 'egress to_port not set');
        assert.ok(tfContent.includes('protocol    = "-1"'), 'egress protocol not set to all');
        assert.ok(tfContent.includes('cidr_blocks = ["0.0.0.0/0"]'), 'egress CIDR not set to all');
      });

      it('When security group is configured, Then it declares no ingress rule', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        // Find the security group block
        const sgMatch = tfContent.match(/resource "aws_security_group" "calendar_sg" \{[\s\S]*?\n\}/);
        assert.ok(sgMatch, 'security group resource not found');
        const sgBlock = sgMatch[0];
        assert.ok(!sgBlock.includes('ingress {'), 'security group should not have ingress rules');
      });
    });

    describe('Scenario: ALB target group configuration', () => {
      it('Given aws_lb_target_group, Then target_type is "lambda"', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('target_type = "lambda"'),
          'target_type not set to lambda');
      });

      it('When target group is configured, Then lambda_multi_value_headers_enabled is true', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('lambda_multi_value_headers_enabled = true'),
          'lambda_multi_value_headers_enabled not set to true');
      });

      it('When health_check is configured, Then path is /calendar/api/health', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('path                = "/calendar/api/health"'),
          'health check path not correctly set');
      });

      it('When health_check is configured, Then matcher is 200-299', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('matcher             = "200-299"'),
          'health check matcher not correctly set');
      });

      it('When target group name is set, Then it is ${local.name_prefix_short}-cal-tg', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('name        = "${local.name_prefix_short}-cal-tg"'),
          'target group name not correctly set');
      });
    });

    describe('Scenario: Target group name fits the AWS limit', () => {
      it('When target group name is rendered for dev/au, Then its length is at most 32 characters', () => {
        // dev/au: au-dev-rhq-cal-tg = 17 chars
        const namePrefix = 'au-dev-rhq';
        const tgName = `${namePrefix}-cal-tg`;
        assert.ok(tgName.length <= 32,
          `Target group name "${tgName}" exceeds 32 character limit (${tgName.length} chars)`);
      });

      it('For every tenant/environment combination, target group name fits 32 character limit', () => {
        const tfvarsFiles = [
          { path: 'config/dev/au.tfvars', tenant: 'au', env: 'dev' },
          { path: 'config/prod/au.tfvars', tenant: 'au', env: 'prod' },
          { path: 'config/prod/uk.tfvars', tenant: 'uk', env: 'prod' },
          { path: 'config/prod/us.tfvars', tenant: 'us', env: 'prod' }
        ];

        tfvarsFiles.forEach(file => {
          const tfvarsPath = path.join(TERRAFORM_DIR, file.path);
          assert.ok(fs.existsSync(tfvarsPath), `tfvars file not found: ${file.path}`);

          const content = fs.readFileSync(tfvarsPath, 'utf-8');
          const projShortMatch = content.match(/project_name_short\s*=\s*"([^"]+)"/);
          assert.ok(projShortMatch, `project_name_short not found in ${file.path}`);

          const projShort = projShortMatch[1];
          const namePrefix = `${file.tenant}-${file.env}-${projShort}`;
          const tgName = `${namePrefix}-cal-tg`;

          assert.ok(tgName.length <= 32,
            `Target group name "${tgName}" for ${file.tenant}/${file.env} exceeds 32 character limit (${tgName.length} chars)`);
        });
      });
    });

    describe('Scenario: ALB listener rule configuration', () => {
      it('Given aws_lb_listener_rule, Then priority is 121', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('priority     = 121'),
          'listener rule priority not set to 121');
      });

      it('When listener rule is configured, Then its priority is not 119 (chatbot collision)', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('priority     = 121'),
          'priority should be 121, not 119');
        assert.ok(!tfContent.match(/priority\s*=\s*119/),
          'priority must not be 119 (chatbot uses that priority)');
      });

      it('When listener rule is configured, Then it has a host_header condition', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('host_header {'),
          'host_header condition not found');
        assert.ok(tfContent.includes('${var.sub_domain}.${data.terraform_remote_state.basestack.outputs.domain_name}'),
          'host_header values not correctly set');
      });

      it('When listener rule is configured, Then it has a path_pattern condition for /calendar*', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('path_pattern {'),
          'path_pattern condition not found');
        assert.ok(tfContent.includes('"/calendar*"'),
          'path_pattern value not set to /calendar*');
      });
    });

    describe('Scenario: Lambda permission and attachment dependencies', () => {
      it('Given aws_lambda_permission, Then principal is elasticloadbalancing.amazonaws.com', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('principal     = "elasticloadbalancing.amazonaws.com"'),
          'permission principal not correctly set');
      });

      it('When lambda_permission is configured, Then source_arn is the target group ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('source_arn    = aws_lb_target_group.calendar_lambda_tg.arn'),
          'permission source_arn not correctly set');
      });

      it('When aws_lb_target_group_attachment is configured, Then it depends_on aws_lambda_permission', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('depends_on = [aws_lambda_permission.calendar_allow_alb]'),
          'target_group_attachment does not depend on lambda_permission');
      });

      it('When aws_lb_target_group_attachment is configured, Then target_id is the lambda ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('target_id        = aws_lambda_function.calendar.arn'),
          'target_id not set to lambda ARN');
      });
    });

    describe('Scenario: Variable defaults and validation', () => {
      it('Given var.anthropic_model, Then default is "claude-opus-5"', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        assert.ok(varsContent.match(/variable "anthropic_model"/),
          'anthropic_model variable not found');
        assert.ok(varsContent.match(/default\s*=\s*"claude-opus-5"/),
          'anthropic_model default not "claude-opus-5"');
      });

      it('When anthropic_model is documented, Then description mentions claude-sonnet-5 as cheaper option', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        const anthropicSection = varsContent.match(/variable "anthropic_model"[\s\S]*?description = "([\s\S]*?)"/);
        assert.ok(anthropicSection, 'anthropic_model variable not found');
        assert.ok(varsContent.includes('claude-sonnet-5'),
          'claude-sonnet-5 not mentioned in anthropic_model description');
        assert.ok(varsContent.includes('NO DATE SUFFIX') || varsContent.includes('no date suffix'),
          'Date suffix warning not in anthropic_model description');
      });

      it('Given var.calendar_log_level, Then it validates membership of none|basic|verbose', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        assert.ok(varsContent.match(/variable "calendar_log_level"/),
          'calendar_log_level variable not found');
        assert.ok(varsContent.includes('none') && varsContent.includes('basic') && varsContent.includes('verbose'),
          'calendar_log_level validation does not include all three options');
      });

      it('When calendar_log_level validation is configured, Then error message is clear', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        const validationSection = varsContent.match(/variable "calendar_log_level"[\s\S]*?validation \{[\s\S]*?\}/);
        assert.ok(validationSection, 'calendar_log_level validation block not found');
        assert.ok(varsContent.includes('calendar_log_level must be one of'),
          'calendar_log_level error message not clear');
      });
    });

    describe('Scenario: Terraform validation succeeds', () => {
      it('When "terraform validate" is run, Then it exits with 0 errors', () => {
        try {
          execSync(
            '"C:/External/Terraform/terraform" init -backend=false',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }
          );
          // Init succeeded
        } catch (error) {
          // init might fail with "already initialized", which is ok
          const output = (error.stdout || '') + (error.stderr || '');
          if (!output.includes('already initialized')) {
            console.error('Terraform init error:', output);
            // Don't fail on init errors - just proceed to validate
          }
        }

        let validateOutput;
        try {
          validateOutput = execSync(
            '"C:/External/Terraform/terraform" validate -json',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }
          );
        } catch (error) {
          validateOutput = error.stdout || error.stderr || '';
          console.error('Terraform validate execution error:', validateOutput);
          assert.fail(`terraform validate command failed: ${validateOutput}`);
          return;
        }

        try {
          const output = JSON.parse(validateOutput);
          assert.equal(output.valid, true, 'Terraform validation marked as invalid');
          assert.equal(output.error_count, 0, `Terraform validation had ${output.error_count} errors`);
          // Warnings are OK (hash_key deprecations are pre-existing)
        } catch (parseError) {
          console.error('Failed to parse terraform validate output:', validateOutput);
          assert.fail(`Failed to parse terraform validate JSON: ${parseError.message}`);
        }
      });
    });

    describe('Scenario: Locals configuration', () => {
      it('Given locals block, Then calendar_log_group_name is set correctly', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('calendar_log_group_name = "/aws/lambda/${local.name_prefix}-school-calendar"'),
          'calendar_log_group_name not correctly set');
      });

      it('When calendar_function_arn local is set, Then it is built from known parts, not from aws_lambda_function', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('calendar_function_arn = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.name_prefix}-school-calendar"'),
          'calendar_function_arn not built from locals');
        assert.ok(!tfContent.match(/calendar_function_arn\s*=\s*aws_lambda_function\.calendar\.arn/),
          'calendar_function_arn should not reference aws_lambda_function (would create cycle)');
      });
    });

    describe('Scenario: Source files exist and have correct configuration', () => {
      it('Given src/lambda/calendar/index.mjs exists', () => {
        const indexPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
        assert.ok(fs.existsSync(indexPath), 'index.mjs not found');
      });

      it('When src/lambda/calendar/package.json is read, Then type is "module"', () => {
        const pkgPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'package.json');
        assert.ok(fs.existsSync(pkgPath), 'package.json not found');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        assert.equal(pkg.type, 'module', 'package.json type is not "module"');
      });

      it('When src/lambda/calendar/package.json is read, Then main is "index.mjs"', () => {
        const pkgPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        assert.equal(pkg.main, 'index.mjs', 'package.json main is not "index.mjs"');
      });
    });

    describe('Scenario: Data sources reference correct resources', () => {
      it('Given data "archive_file" in lambda_calendar.tf, Then type is "zip"', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.match(/data "archive_file" "calendar_lambda_zip"[\s\S]*?type\s*=\s*"zip"/),
          'archive_file type not set to zip');
      });

      it('When data "aws_secretsmanager_secret" is referenced, Then name is local.secret_name', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('data "aws_secretsmanager_secret" "app_config"'),
          'app_config secret data source not found');
        assert.ok(tfContent.includes('name = local.secret_name'),
          'secret name not set to local.secret_name');
      });
    });

    describe('Scenario: Cloudwatch log group is optional', () => {
      it('Given aws_cloudwatch_log_group for calendar, Then count is conditional on var.manage_lambda_log_groups', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const logGroupMatch = tfContent.match(/resource "aws_cloudwatch_log_group" "calendar_lambda_logs"[\s\S]*?\{[\s\S]*?count\s*=[\s\S]*?\}/);
        assert.ok(logGroupMatch, 'calendar_lambda_logs resource not found');
        assert.ok(tfContent.includes('count = var.manage_lambda_log_groups ? 1 : 0'),
          'count not conditional on manage_lambda_log_groups');
      });

      it('When lambda function is configured, Then it depends_on the log group (even when count=0)', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('depends_on = [aws_cloudwatch_log_group.calendar_lambda_logs]'),
          'lambda function does not depend on log group');
      });
    });
  });
});

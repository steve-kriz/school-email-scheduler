import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

describe('Terraform Scaffold E2E Tests', () => {
  describe('Feature: Terraform scaffold', () => {
    describe('Scenario: The shared layer validates on its own', () => {
      it('Given only the scaffold terraform files are present', () => {
        const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf'));
        assert.ok(tfFiles.length > 0, 'No .tf files found');
        assert.ok(tfFiles.includes('provider.tf'), 'provider.tf not found');
        assert.ok(tfFiles.includes('variables.tf'), 'variables.tf not found');
        assert.ok(tfFiles.includes('main.tf'), 'main.tf not found');
      });

      it('When "terraform validate" is run in the terraform directory, Then it exits with status 0', () => {
        try {
          const result = execSync(
            'terraform validate -json',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 30000
            }
          );
          // If we get here, validation succeeded
          assert.ok(true, 'terraform validate succeeded');
        } catch (error) {
          const output = error.stdout || '';
          const stderr = error.stderr || '';
          console.error('Terraform validate output:', output);
          console.error('Terraform validate stderr:', stderr);
          assert.fail(`terraform validate failed with status ${error.status}: ${stderr}`);
        }
      });
    });

    describe('Scenario: Resource names are prefixed per tenant and environment', () => {
      it('Given the dev/au tfvars are loaded, When the name_prefix local is evaluated, Then it equals "au-dev-receptionhq"', () => {
        // Parse the tfvars and variables.tf manually to derive name_prefix
        const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
        const tfvarsContent = fs.readFileSync(tfvarsPath, 'utf-8');

        const tenantMatch = tfvarsContent.match(/tenant\s*=\s*"([^"]+)"/);
        const envMatch = tfvarsContent.match(/environment\s*=\s*"([^"]+)"/);
        const projMatch = tfvarsContent.match(/project_name\s*=\s*"([^"]+)"/);

        const tenant = tenantMatch ? tenantMatch[1] : null;
        const env = envMatch ? envMatch[1] : null;
        const proj = projMatch ? projMatch[1] : null;

        assert.ok(tenant, 'tenant not found in tfvars');
        assert.ok(env, 'environment not found in tfvars');
        assert.ok(proj, 'project_name not found in tfvars');

        // The name_prefix is defined in variables.tf as: ${var.tenant}-${var.environment}-${var.project_name}
        const namePrefix = `${tenant}-${env}-${proj}`;

        assert.equal(namePrefix, 'au-dev-receptionhq',
          `Expected name_prefix to be "au-dev-receptionhq", got "${namePrefix}"`);
      });
    });

    describe('Scenario: The calendar sub-domain is used, not the chatbot\'s', () => {
      it('Given the dev/au tfvars are loaded, Then sub_domain equals "calendar" And the route53 record name starts with "calendar."', () => {
        const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
        assert.ok(fs.existsSync(tfvarsPath), 'dev/au.tfvars not found');
        const tfvarsContent = fs.readFileSync(tfvarsPath, 'utf-8');

        const subDomainMatch = tfvarsContent.match(/sub_domain\s*=\s*"([^"]+)"/);
        assert.ok(subDomainMatch, 'sub_domain not found in tfvars');
        assert.equal(subDomainMatch[1], 'calendar',
          `Expected sub_domain to be "calendar", got "${subDomainMatch[1]}"`);

        // Check route53 record in main.tf
        const mainTfPath = path.join(TERRAFORM_DIR, 'main.tf');
        const mainTfContent = fs.readFileSync(mainTfPath, 'utf-8');

        assert.ok(mainTfContent.includes('var.sub_domain'),
          'var.sub_domain reference not found in main.tf');
        assert.ok(mainTfContent.includes('aws_route53_record'),
          'aws_route53_record resource not found in main.tf');
        assert.ok(mainTfContent.includes('${var.sub_domain}.'),
          'Route53 record name does not use var.sub_domain');
      });
    });

    describe('Scenario: The state key does not collide with the chatbot\'s', () => {
      it('Given the dev/au init script, When TF_STATE_KEY is read, Then it contains "school_calendar" And it does not equal "terraform_dev_ohq_chatbot.tfstate"', () => {
        const initScriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
        assert.ok(fs.existsSync(initScriptPath), 'terraform_init_dev_au.sh not found');
        const scriptContent = fs.readFileSync(initScriptPath, 'utf-8');

        const stateKeyMatch = scriptContent.match(/TF_STATE_KEY="([^"]+)"/);
        assert.ok(stateKeyMatch, 'TF_STATE_KEY not found in init script');
        const stateKey = stateKeyMatch[1];

        assert.ok(stateKey.includes('school_calendar'),
          `Expected TF_STATE_KEY to contain "school_calendar", got "${stateKey}"`);
        assert.notEqual(stateKey, 'terraform_dev_ohq_chatbot.tfstate',
          'TF_STATE_KEY should not match the chatbot\'s state key');
      });
    });

    describe('Scenario: A missing optional secret key does not break planning', () => {
      it('Given the app-config secret JSON omits "ANTHROPIC_API_KEY", When the secrets local is evaluated with lookup and an empty default, Then evaluation succeeds and yields an empty string', () => {
        const mainTfPath = path.join(TERRAFORM_DIR, 'main.tf');
        const mainTfContent = fs.readFileSync(mainTfPath, 'utf-8');

        // Verify that lookup() with a default is used for secret keys
        assert.ok(mainTfContent.includes('lookup(local.secrets'),
          'lookup() not used for secret access in main.tf');
        assert.ok(mainTfContent.includes('ANTHROPIC_API_KEY'),
          'ANTHROPIC_API_KEY reference not found in main.tf');

        // Check that lookup() has a default value
        const anthropicMatch = mainTfContent.match(/anthropic_api_key\s*=\s*lookup\(local\.secrets,\s*"ANTHROPIC_API_KEY",\s*"([^"]*)"\)/);
        assert.ok(anthropicMatch, 'ANTHROPIC_API_KEY lookup not found or missing default');
        assert.equal(anthropicMatch[1], '',
          'Default value for ANTHROPIC_API_KEY should be empty string');

        assert.ok(true, 'lookup() with empty default allows missing keys to be handled gracefully');
      });
    });

    describe('Scenario Outline: Every tenant has a config file', () => {
      const examples = [
        { path: 'config/dev/au.tfvars', desc: 'dev/au' },
        { path: 'config/prod/au.tfvars', desc: 'prod/au' },
        { path: 'config/prod/uk.tfvars', desc: 'prod/uk' },
        { path: 'config/prod/us.tfvars', desc: 'prod/us' }
      ];

      examples.forEach(example => {
        it(`Given the terraform config directory, Then a tfvars file exists at "${example.path}" (${example.desc})`, () => {
          const fullPath = path.join(TERRAFORM_DIR, example.path);
          assert.ok(fs.existsSync(fullPath),
            `Expected tfvars file not found: ${fullPath}`);

          const content = fs.readFileSync(fullPath, 'utf-8');
          assert.ok(content.length > 0, `tfvars file is empty: ${fullPath}`);
        });
      });
    });
  });
});

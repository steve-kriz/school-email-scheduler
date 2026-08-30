/**
 * TASK-051 unit tests: pure text/pure-function coverage of the terraform
 * refactor that reduces the stack to one deployable environment (dev/au).
 *
 * These are deliberately terraform-binary-free and child-process-free: every
 * assertion here parses source text read off disk, or calls an exported pure
 * function from scripts/check-oauth-config.mjs. NO DATABASE CONNECTION IS EVER
 * OPENED - the only DynamoDB names anywhere in this file are terraform source
 * text being read as strings, and no AWS SDK client is constructed.
 *
 * The Given/When/Then scenarios live in
 * tests/e2e/task-051-terraform-refactor.test.js.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TENANT_REGIONS, regionFor, secretIdFor } from '../../scripts/check-oauth-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

/**
 * Strip `#` / `//` comment lines.
 *
 * This matters more than usual for this ticket: the coder left long comments
 * that NAME every removed thing (var.account_id, allowed_account_ids,
 * legacystack, aws_global, sub_domain...). A plain `content.includes('x')`
 * over the raw file would find those names in prose and conclude the code
 * survived. Absence is therefore always asserted against code only, and the
 * presence of the explanatory prose is asserted separately against
 * commentsOnly().
 */
function codeOnly(content) {
  return content.split('\n').filter(line => !/^\s*(#|\/\/)/.test(line)).join('\n');
}

function commentsOnly(content) {
  return content.split('\n').filter(line => /^\s*(#|\/\/)/.test(line)).join('\n');
}

function listTfFiles() {
  return fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf')).sort();
}

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

const KEPT_VARIABLES = [
  'region',
  'environment',
  'tenant',
  'project_name',
  'Alert_SNS_ARN',
  'tags',
  'manage_lambda_log_groups',
  'calendar_log_level',
  'anthropic_model',
  'public_base_url',
  'terraform_remote_state_basestack_config'
];

describe('TASK-051 unit: terraform reduced to a single deployable environment', () => {

  // ---------------------------------------------------------------------------
  describe('the comment-stripping helper these assertions depend on', () => {
    // If codeOnly() were wrong, every absence assertion below would be
    // vacuous - it would strip too much and "prove" anything is gone. So it
    // gets its own coverage first.
    it('removes # and // comment lines but keeps code', () => {
      const source = [
        '# var.account_id was removed by TASK-051.',
        '  // so was the aws_global alias',
        'variable "region" {',
        '  type = string # trailing comments stay on their code line',
        '}'
      ].join('\n');
      const stripped = codeOnly(source);
      assert.ok(!stripped.includes('var.account_id'), 'a full-line # comment survived stripping');
      assert.ok(!stripped.includes('aws_global'), 'an indented // comment survived stripping');
      assert.ok(stripped.includes('variable "region" {'), 'a code line was stripped');
      assert.ok(stripped.includes('type = string'), 'a code line with a trailing comment was stripped');
    });

    it('keeps only comment lines in commentsOnly, so a documented removal is provable', () => {
      const source = 'variable "region" {}\n# deliberate: allowed_account_ids removed\n';
      const comments = commentsOnly(source);
      assert.ok(comments.includes('allowed_account_ids'), 'a comment line was dropped');
      assert.ok(!comments.includes('variable "region"'), 'a code line leaked into commentsOnly');
    });
  });

  // ---------------------------------------------------------------------------
  describe('variables.tf declarations', () => {
    let variablesTf;
    before(() => { variablesTf = readTf('variables.tf'); });

    REMOVED_VARIABLES.forEach(name => {
      it(`no longer declares variable "${name}"`, () => {
        assert.ok(!new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesTf),
          `variable "${name}" is still declared in variables.tf`);
      });
    });

    KEPT_VARIABLES.forEach(name => {
      it(`still declares variable "${name}"`, () => {
        assert.ok(new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesTf),
          `variable "${name}" is required by the stack but is missing from variables.tf`);
      });
    });

    it('keeps local.name_prefix interpolating tenant, environment then project_name in that order', () => {
      // Byte-for-byte: any reordering renames every resource in the stack,
      // which terraform executes as destroy-and-recreate.
      const match = variablesTf.match(/^[ \t]*name_prefix[ \t]*=[ \t]*(\S.*)$/m);
      assert.ok(match, 'local.name_prefix assignment not found');
      assert.equal(match[1].trim(), '"${var.tenant}-${var.environment}-${var.project_name}"',
        'local.name_prefix interpolation changed');
    });

    it('keeps local.secret_name interpolating environment then tenant', () => {
      const match = variablesTf.match(/^[ \t]*secret_name[ \t]*=[ \t]*(\S.*)$/m);
      assert.ok(match, 'local.secret_name assignment not found');
      assert.equal(match[1].trim(), '"${var.environment}-${var.tenant}/app-config/school_calendar_services"',
        'local.secret_name interpolation changed - the Lambda would read a secret that does not exist');
    });

    it('no longer defines local.name_prefix_short', () => {
      assert.ok(!codeOnly(variablesTf).includes('name_prefix_short'),
        'local.name_prefix_short survives, but the ALB target group that needed a 32-char name is gone');
    });

    it('explains each removal in a comment rather than deleting silently', () => {
      const comments = commentsOnly(variablesTf);
      for (const name of ['project_name_short', 'account_id', 'terraform_remote_state_legacystack_config',
        'timezone', 'hosted_zone_id']) {
        assert.ok(comments.includes(name),
          `variables.tf removes ${name} with no comment saying why; the next reader cannot tell a deliberate cut from a botched merge`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('no .tf file references a removed variable', () => {
    it('finds zero var.X references to any of the ten removed variables', () => {
      const offenders = [];
      for (const file of listTfFiles()) {
        const code = codeOnly(readTf(file));
        for (const name of REMOVED_VARIABLES) {
          // \b prevents var.hosted_zone matching var.hosted_zone_id and
          // reporting a phantom offender (or vice versa).
          if (new RegExp(`var\\.${name}\\b`).test(code)) offenders.push(`${file} -> var.${name}`);
        }
      }
      assert.deepEqual(offenders, [],
        `terraform would reject these as "Reference to undeclared input variable": ${offenders.join(', ')}`);
    });

    it('is discriminating: the same scan flags a reference when one is present', () => {
      // Proves the scan above is not passing because the regex never matches.
      const fixture = 'locals {\n  x = "${var.account_id}"\n}\n';
      const hit = REMOVED_VARIABLES.filter(name => new RegExp(`var\\.${name}\\b`).test(codeOnly(fixture)));
      assert.deepEqual(hit, ['account_id'],
        'the removed-variable scan does not detect a var.account_id reference it is supposed to catch');
    });

    it('does not confuse var.hosted_zone with var.hosted_zone_id', () => {
      const fixture = 'locals {\n  x = var.hosted_zone_id\n}\n';
      const hit = REMOVED_VARIABLES.filter(name => new RegExp(`var\\.${name}\\b`).test(fixture));
      assert.deepEqual(hit, ['hosted_zone_id'],
        'the \\b anchor is not preventing a prefix match between hosted_zone and hosted_zone_id');
    });
  });

  // ---------------------------------------------------------------------------
  describe('provider.tf', () => {
    let providerTf;
    before(() => { providerTf = readTf('provider.tf'); });

    it('declares exactly one provider "aws" block', () => {
      const blocks = providerTf.match(/^provider\s+"aws"\s*\{/gm) || [];
      assert.equal(blocks.length, 1, `expected one provider "aws" block, found ${blocks.length}`);
    });

    it('declares no allowed_account_ids argument', () => {
      assert.ok(!codeOnly(providerTf).includes('allowed_account_ids'),
        'allowed_account_ids is still an active argument');
    });

    it('documents the dropped guard as deliberate, in a comment above the provider block', () => {
      const beforeProvider = providerTf.slice(0, providerTf.search(/^provider\s+"aws"\s*\{/m));
      const comments = commentsOnly(beforeProvider);
      assert.ok(comments.includes('allowed_account_ids'),
        'nothing above the provider block mentions allowed_account_ids - the guard is silently missing');
      assert.match(comments, /deliberate|deliberately|accepted|informed regression/i,
        'the comment does not state the removal was deliberate');
    });

    it('declares no aws_global alias block', () => {
      const code = codeOnly(providerTf);
      assert.ok(!code.includes('aws_global'), 'the aws_global alias survives');
      assert.ok(!/^\s*alias\s*=/m.test(code), 'a provider alias is still declared');
      assert.ok(!code.includes('us-east-1'), 'us-east-1 is still hardcoded in provider.tf');
    });

    it('declares no legacystack remote state and keeps the basestack one', () => {
      const code = codeOnly(providerTf);
      assert.ok(!code.includes('legacystack'), 'the legacystack remote state or its config variable survives');
      assert.ok(/data\s+"terraform_remote_state"\s+"basestack"/.test(code),
        'the basestack remote state was removed; the Lambda would lose its VPC wiring');
      for (const key of ['bucket', 'key', 'region']) {
        assert.ok(code.includes(`var.terraform_remote_state_basestack_config["${key}"]`),
          `the basestack data source no longer indexes ["${key}"]`);
      }
    });

    it('keeps data.aws_caller_identity.current, which the two ARNs now depend on', () => {
      assert.ok(/^data\s+"aws_caller_identity"\s+"current"\s*\{/m.test(providerTf),
        'data "aws_caller_identity" "current" is missing, so both constructed ARNs would fail validation');
    });

    it("keeps TASK-050's backend settings untouched", () => {
      const terraformBlock = providerTf.slice(providerTf.indexOf('terraform {'), providerTf.indexOf('provider "aws"'));
      assert.match(terraformBlock, /required_version\s*=\s*">=\s*1\.10"/, 'required_version >= 1.10 lost');
      assert.match(terraformBlock, /source\s*=\s*"hashicorp\/aws"/, 'hashicorp/aws source changed');
      assert.match(terraformBlock, /version\s*=\s*"~>\s*6\.19"/, 'aws version constraint is no longer ~> 6.19');

      const backend = terraformBlock.slice(terraformBlock.indexOf('backend "s3"'));
      assert.match(backend, /encrypt\s*=\s*true/, 'backend no longer sets encrypt = true');
      assert.match(backend, /use_lockfile\s*=\s*true/, 'backend no longer sets use_lockfile = true');
      assert.ok(!codeOnly(backend).includes('dynamodb_table'), 'backend reintroduced dynamodb_table');
      for (const key of ['bucket', 'key', 'region']) {
        assert.ok(!new RegExp(`^\\s*${key}\\s*=`, 'm').test(codeOnly(backend)),
          `backend now hardcodes ${key}; it comes from -backend-config in the init script`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('constructed ARNs use the caller identity', () => {
    it('local.calendar_function_arn interpolates data.aws_caller_identity.current.account_id', () => {
      assert.ok(readTf('lambda_calendar.tf').includes(
        'calendar_function_arn = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name_prefix}-school-calendar"'),
      'local.calendar_function_arn is not built from the caller identity');
    });

    it('the ManageScanSchedules resource scope interpolates it too, with an unchanged scope', () => {
      assert.ok(readTf('scheduler_calendar.tf').includes(
        'Resource = "arn:aws:scheduler:${var.region}:${data.aws_caller_identity.current.account_id}:schedule/default/${local.name_prefix}-calendar-scan-*"'),
      'the ManageScanSchedules scope is not built from the caller identity, or its shape changed');
    });

    it('neither file hardcodes a 12-digit account number in an ARN', () => {
      for (const file of ['lambda_calendar.tf', 'scheduler_calendar.tf']) {
        for (const line of codeOnly(readTf(file)).split('\n').filter(l => l.includes('arn:aws:'))) {
          assert.ok(!/:\d{12}:/.test(line), `${file} hardcodes an account id: ${line.trim()}`);
        }
      }
    });

    it('lambda_calendar.tf still reads both basestack outputs', () => {
      const lambdaTf = readTf('lambda_calendar.tf');
      assert.ok(lambdaTf.includes('subnet_ids         = data.terraform_remote_state.basestack.outputs.private_subnet_ids'),
        "the Lambda's vpc_config no longer takes subnet_ids from the basestack remote state");
      assert.ok(lambdaTf.includes('vpc_id      = data.terraform_remote_state.basestack.outputs.vpc_id'),
        'the security group no longer takes vpc_id from the basestack remote state');
    });
  });

  // ---------------------------------------------------------------------------
  describe('config and init scripts on disk', () => {
    it('has exactly one tfvars file, config/dev/au.tfvars', () => {
      const found = [];
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.tfvars')) found.push(path.relative(CONFIG_DIR, full).replace(/\\/g, '/'));
        }
      };
      walk(CONFIG_DIR);
      assert.deepEqual(found.sort(), ['dev/au.tfvars'], `found: ${found.join(', ') || '(none)'}`);
    });

    it('has no terraform/config/prod/ directory', () => {
      assert.ok(!fs.existsSync(path.join(CONFIG_DIR, 'prod')), 'terraform/config/prod/ still exists');
    });

    it('has exactly one init script, terraform_init_dev_au.sh', () => {
      const scripts = fs.readdirSync(TERRAFORM_DIR).filter(f => /^terraform_init_.*\.sh$/.test(f)).sort();
      assert.deepEqual(scripts, ['terraform_init_dev_au.sh'], `found: ${scripts.join(', ')}`);
    });

    it('dev/au.tfvars assigns no removed key', () => {
      const tfvars = codeOnly(readTf('config', 'dev', 'au.tfvars'));
      for (const name of REMOVED_VARIABLES) {
        assert.ok(!new RegExp(`^\\s*${name}\\s*=`, 'm').test(tfvars),
          `dev/au.tfvars still assigns "${name}" with no matching declaration`);
      }
    });

    it('dev/au.tfvars still sets every required variable that has no default', () => {
      const tfvars = codeOnly(readTf('config', 'dev', 'au.tfvars'));
      // These are the declarations in variables.tf with no `default`, so a
      // missing key here is a hard "No value for required variable".
      for (const name of ['project_name', 'region', 'environment', 'tenant', 'Alert_SNS_ARN']) {
        assert.ok(new RegExp(`^\\s*${name}\\s*=`, 'm').test(tfvars),
          `dev/au.tfvars no longer sets required variable "${name}"`);
      }
      assert.ok(tfvars.includes('terraform_remote_state_basestack_config'),
        'dev/au.tfvars no longer sets terraform_remote_state_basestack_config');
    });

    it('dev/au.tfvars keeps bucket, key and region in the basestack map', () => {
      const tfvars = readTf('config', 'dev', 'au.tfvars');
      const mapStart = tfvars.indexOf('terraform_remote_state_basestack_config');
      assert.ok(mapStart >= 0, 'basestack map not found');
      const mapBody = tfvars.slice(mapStart, tfvars.indexOf('}', mapStart));
      for (const key of ['bucket', 'key', 'region']) {
        const match = mapBody.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
        assert.ok(match, `basestack map has no ${key}`);
        assert.ok(match[1].length > 0, `basestack map's ${key} is an empty string`);
      }
    });

    it('keeps the dev/au tfvars pinned to the values local.name_prefix and local.secret_name are built from', () => {
      // The e2e suite proves the evaluated result with terraform console; this
      // pins the inputs so a wrong value here is caught even without the binary.
      const tfvars = readTf('config', 'dev', 'au.tfvars');
      const expected = { project_name: 'receptionhq', region: 'ap-southeast-2', environment: 'dev', tenant: 'au' };
      for (const [key, value] of Object.entries(expected)) {
        const match = tfvars.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
        assert.ok(match, `dev/au.tfvars does not set ${key}`);
        assert.equal(match[1], value,
          `dev/au.tfvars ${key} is "${match[1]}", which would change local.name_prefix/local.secret_name`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('scripts/check-oauth-config.mjs tenant map', () => {
    it('lists only the dev-au pair', () => {
      assert.deepEqual(Object.keys(TENANT_REGIONS), ['dev-au'],
        `TENANT_REGIONS should have one entry, got: ${Object.keys(TENANT_REGIONS).join(', ')}`);
      assert.equal(TENANT_REGIONS['dev-au'], 'ap-southeast-2');
    });

    it("matches config/dev/au.tfvars's region, which is the map's source of truth", () => {
      const tfvarsRegion = readTf('config', 'dev', 'au.tfvars').match(/^\s*region\s*=\s*"([^"]+)"/m);
      assert.ok(tfvarsRegion, 'region not found in dev/au.tfvars');
      assert.equal(TENANT_REGIONS['dev-au'], tfvarsRegion[1],
        'TENANT_REGIONS["dev-au"] has drifted from the region in config/dev/au.tfvars');
    });

    it('every key in the map has a matching tfvars file on disk', () => {
      for (const pair of Object.keys(TENANT_REGIONS)) {
        const [environment, tenant] = pair.split('-');
        assert.ok(fs.existsSync(path.join(CONFIG_DIR, environment, `${tenant}.tfvars`)),
          `TENANT_REGIONS lists "${pair}" but terraform/config/${environment}/${tenant}.tfvars does not exist`);
      }
    });

    it('EDGE: a removed prod pair still derives a secret id but takes the region fallback', () => {
      // The removal is scoped to the region DEFAULT. secretIdFor is pure string
      // building and must keep working, so a hand-recovered prod tenant still
      // resolves to the same secret; only --region becomes mandatory.
      const fallback = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2';
      for (const tenant of ['au', 'uk', 'us']) {
        assert.equal(secretIdFor('prod', tenant), `prod-${tenant}/app-config/school_calendar_services`,
          `secretIdFor stopped working for prod-${tenant}`);
        assert.equal(TENANT_REGIONS[`prod-${tenant}`], undefined,
          `prod-${tenant} is still in TENANT_REGIONS`);
        assert.equal(regionFor('prod', tenant), fallback,
          `prod-${tenant} should now take the ambient/default region fallback`);
      }
    });

    it('EDGE: an entirely unknown pair takes the same fallback, so removal changed no behaviour class', () => {
      const fallback = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2';
      assert.equal(regionFor('nosuch', 'zz'), fallback,
        'an unknown pair no longer falls back to the ambient/default region');
      assert.equal(regionFor('prod', 'uk'), regionFor('nosuch', 'zz'),
        'a removed prod pair and an unknown pair should now resolve identically');
    });
  });

  // ---------------------------------------------------------------------------
  describe('docs/google-oauth-setup.md', () => {
    let runbook;
    before(() => { runbook = fs.readFileSync(path.join(DOCS_DIR, 'google-oauth-setup.md'), 'utf-8'); });

    it('never tells an operator to run a prod init script', () => {
      for (const tenant of ['au', 'uk', 'us']) {
        assert.ok(!runbook.includes(`terraform_init_prod_${tenant}.sh`),
          `the runbook still references terraform_init_prod_${tenant}.sh`);
      }
    });

    it('has no table row presenting a prod tenant as deployable', () => {
      assert.ok(!/\|\s*`?prod`?\s*\|\s*`?(au|uk|us)`?\s*\|/.test(runbook),
        'the runbook still lists a prod tenant row');
    });

    it('lists no prod secret id as one to create', () => {
      assert.ok(!/prod-(au|uk|us)\/app-config\/school_calendar_services/.test(runbook),
        'the runbook still lists a prod secret id');
    });

    it('states that only dev/au is deployable from this repo', () => {
      assert.match(runbook, /only\s+`?dev`?\s*\/\s*`?au`?\s+is deployable/i,
        'the runbook does not say only dev/au is deployable');
    });

    it('still documents the dev/au redirect URI and the localhost one', () => {
      assert.ok(runbook.includes('<terraform output calendar_function_url>calendar/api/auth/google/callback'),
        'the runbook no longer derives the redirect URI from the function URL output');
      assert.ok(runbook.includes('http://localhost:3000/calendar/api/auth/google/callback'),
        'the runbook no longer documents the localhost callback URI');
    });

    it('FAILURE PATH: advertises none of the removed calendar.<hosted_zone> ALB hostnames', () => {
      for (const zone of ['dev.receptionhq.com', 'receptionhq.com', 'uk.receptionhq.com', 'us.receptionhq.com']) {
        assert.ok(!runbook.includes(`https://calendar.${zone}/calendar/api/auth/google/callback`),
          `the runbook still lists the removed ALB hostname calendar.${zone}`);
      }
    });
  });
});

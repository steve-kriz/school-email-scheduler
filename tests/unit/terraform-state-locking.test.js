/**
 * TASK-050 unit tests: the Terraform S3 backend locks state with a native S3
 * lockfile (`use_lockfile = true`) instead of a DynamoDB state-lock table.
 *
 * These are pure-function/text tests. No terraform binary is invoked, no
 * child process is spawned, no network call is made, and NO DATABASE
 * CONNECTION IS EVER OPENED - the only DynamoDB tables mentioned anywhere in
 * this file are terraform source text being read off disk as strings.
 *
 * The matching Given/When/Then scenarios live in
 * tests/e2e/terraform-state-locking.test.js.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maskCommentsAndStrings,
  maskCommentsOnly,
  extractLabelledBlock,
  extractBackendS3Block,
  extractTerraformBlock,
  extractMapLiteral,
  parseAssignments,
  unquote,
  constraintAllows,
  parseInitScript,
  INIT_SCRIPTS,
  TFVARS_FILES,
  REMOTE_STATE_MAPS,
  REMOVED_REMOTE_STATE_MAPS
} from '../helpers/tf-state-locking.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

describe('TASK-050 unit: S3-native state locking replaces the DynamoDB lock table', () => {
  let providerContent;
  let backendBlock;
  let terraformBlock;

  before(() => {
    providerContent = readTf('provider.tf');
    backendBlock = extractBackendS3Block(providerContent);
    terraformBlock = extractTerraformBlock(providerContent);
  });

  // -------------------------------------------------------------------------
  describe('the backend "s3" block', () => {
    it('is present and parseable as a labelled block', () => {
      assert.ok(backendBlock,
        'could not extract the body of the `backend "s3" { ... }` block from terraform/provider.tf');
    });

    it('declares use_lockfile = true', () => {
      const assignments = parseAssignments(backendBlock);
      assert.ok(assignments.has('use_lockfile'),
        `backend "s3" declares no use_lockfile key; keys found: ${[...assignments.keys()].join(', ')}`);
      assert.equal(assignments.get('use_lockfile'), 'true',
        `use_lockfile should be literally true, got ${assignments.get('use_lockfile')}`);
    });

    it('declares encrypt = true', () => {
      const assignments = parseAssignments(backendBlock);
      assert.equal(assignments.get('encrypt'), 'true',
        `backend "s3" should still set encrypt = true, got ${assignments.get('encrypt')}`);
    });

    it('declares no dynamodb_table key', () => {
      const assignments = parseAssignments(backendBlock);
      assert.ok(!assignments.has('dynamodb_table'),
        'backend "s3" still declares dynamodb_table; state locking must come from use_lockfile alone');
    });

    it('preserves partial config: no literal bucket, key or region', () => {
      const assignments = parseAssignments(backendBlock);
      for (const forbidden of ['bucket', 'key', 'region']) {
        assert.ok(!assignments.has(forbidden),
          `backend "s3" hardcodes ${forbidden} = ${assignments.get(forbidden)}; ` +
          'it must stay partial config supplied by the init scripts via -backend-config');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('dynamodb_table is gone from provider.tf code, not just reworded', () => {
    it('does not reference dynamodb_table anywhere in executable HCL', () => {
      // Comments and string bodies are blanked first, so the explanatory
      // comment about the upstream-owned lock table cannot be mistaken for a
      // live reference - and equally, a real reference cannot hide behind one.
      const code = maskCommentsAndStrings(providerContent);
      assert.ok(!code.includes('dynamodb_table'),
        'terraform/provider.tf still references dynamodb_table in code (comments excluded)');
    });

    it('still documents why the shared upstream lock table is left in place', () => {
      // AC: "the PR states explicitly that it is left in place because it is
      // upstream/shared". provider.tf is where an operator will look.
      assert.match(providerContent, /DynamoDB lock table/i,
        'provider.tf no longer explains what happened to the DynamoDB lock table');
      assert.match(providerContent, /upstream-owned|upstream\/shared|shared/i,
        'provider.tf does not record that the lock table is upstream-owned/shared');
    });
  });

  // -------------------------------------------------------------------------
  describe('the terraform block pins a version that supports use_lockfile', () => {
    let requiredVersion;

    before(() => {
      const assignments = parseAssignments(terraformBlock);
      requiredVersion = unquote(assignments.get('required_version'));
    });

    it('declares required_version', () => {
      assert.ok(requiredVersion,
        'the terraform { } block declares no required_version, so a pre-1.10 binary ' +
        'would silently initialise an unlocked backend');
    });

    it('admits Terraform 1.10.0 and later', () => {
      for (const version of ['1.10.0', '1.11.4', '1.16.0']) {
        assert.ok(constraintAllows(requiredVersion, version),
          `required_version ${JSON.stringify(requiredVersion)} rejects ${version}, ` +
          'but use_lockfile is supported there');
      }
    });

    it('REJECTS every pre-1.10 Terraform (the unlocked-backend failure path)', () => {
      // This is the edge case the ticket calls out: without this pin an old
      // binary gets a backend with no locking at all.
      for (const version of ['0.14.11', '1.5.7', '1.8.5', '1.9.8']) {
        assert.equal(constraintAllows(requiredVersion, version), false,
          `required_version ${JSON.stringify(requiredVersion)} would ADMIT Terraform ${version}, ` +
          'which predates use_lockfile and would run unlocked');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the aws provider constraint is unchanged', () => {
    it('still constrains hashicorp/aws to "~> 6.19"', () => {
      const requiredProviders = extractLabelledBlock(terraformBlock, 'required_providers');
      assert.ok(requiredProviders, 'no required_providers block found');
      const aws = extractLabelledBlock(requiredProviders, 'aws\\s*=');
      assert.ok(aws, 'no aws entry found inside required_providers');

      const assignments = parseAssignments(aws);
      assert.equal(unquote(assignments.get('source')), 'hashicorp/aws',
        `aws provider source changed: ${assignments.get('source')}`);
      assert.equal(unquote(assignments.get('version')), '~> 6.19',
        `aws provider version constraint changed: ${assignments.get('version')}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('the terraform_remote_state data sources drop the inert lock table key', () => {
    // Only basestack now: TASK-051 deleted data.terraform_remote_state.legacystack
    // (nothing in this stack ever read an output from it). Its absence is asserted
    // explicitly below rather than left as a silently shorter loop.
    it('legacystack is gone entirely, so there is no second remote state to check', () => {
      assert.ok(
        !extractLabelledBlock(providerContent, 'data\\s+"terraform_remote_state"\\s+"legacystack"'),
        'data "terraform_remote_state" "legacystack" is still declared in provider.tf; TASK-051 removed it');
    });

    // INVERTED BY TASK-052. This loop used to run over ['basestack'] and assert
    // that data source indexed exactly bucket/key/region and no longer indexed
    // dynamodb_table. TASK-052 removed the Lambda's vpc_config and
    // aws_security_group.calendar_sg - basestack's only two readers - and
    // deleted the data source with them, so there is no remote state left in
    // this stack at all. The strongest form of "it does not index a lock table"
    // is now "it does not exist", asserted explicitly rather than by letting an
    // emptied loop body run zero times.
    it('basestack is gone too, so no remote state data source survives to index anything', () => {
      assert.ok(
        !extractLabelledBlock(providerContent, 'data\\s+"terraform_remote_state"\\s+"basestack"'),
        'data "terraform_remote_state" "basestack" is still declared in provider.tf; TASK-052 removed it ' +
        'along with the VPC attachment that was its last reader');
      assert.ok(!/data\s+"terraform_remote_state"/.test(maskCommentsAndStrings(providerContent)),
        'provider.tf still declares some terraform_remote_state data source');
    });

    it('and with no remote state left, provider.tf indexes no dynamodb_table lock table key anywhere', () => {
      assert.ok(!maskCommentsAndStrings(providerContent).includes('dynamodb_table'),
        'provider.tf still indexes ["dynamodb_table"], which is a hard Invalid index error ' +
        'once the key is gone from the tfvars maps');
      assert.ok(!maskCommentsAndStrings(providerContent).includes('terraform_remote_state_basestack_config'),
        'provider.tf still reads var.terraform_remote_state_basestack_config, which no longer exists');
    });

    it('REMOTE_STATE_MAPS is empty on purpose, and the loops below are therefore vacuous by design', () => {
      // Guards the shared helper constant itself: if a future ticket re-adds a
      // remote state it must re-add it here too, or the tfvars loops below
      // would go on silently checking nothing.
      assert.deepEqual(REMOTE_STATE_MAPS, [],
        'REMOTE_STATE_MAPS is non-empty, but this stack reads no remote state since TASK-052');
      assert.deepEqual([...REMOVED_REMOTE_STATE_MAPS].sort(),
        ['terraform_remote_state_basestack_config', 'terraform_remote_state_legacystack_config'],
        'REMOVED_REMOTE_STATE_MAPS must list both deleted remote-state config variables');
    });

    for (const mapName of REMOVED_REMOTE_STATE_MAPS) {
      it(`neither provider.tf nor variables.tf mentions ${mapName} in code`, () => {
        assert.ok(!maskCommentsAndStrings(providerContent).includes(mapName),
          `provider.tf still references ${mapName}`);
        const variablesContent = readTf('variables.tf');
        assert.ok(!new RegExp(`^\\s*variable\\s+"${mapName}"`, 'm')
          .test(maskCommentsAndStrings(variablesContent)),
        `variables.tf still declares variable "${mapName}"`);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('the four init scripts no longer supply a lock table', () => {
    for (const script of INIT_SCRIPTS) {
      describe(script.file, () => {
        let parsed;
        let content;

        before(() => {
          content = readTf(script.file);
          parsed = parseInitScript(content);
        });

        it('passes -backend-config for bucket, key and region', () => {
          for (const expected of ['bucket', 'key', 'region']) {
            assert.ok(parsed.backendConfigKeys.includes(expected),
              `${script.file} no longer passes -backend-config="${expected}=..."; ` +
              `keys found: ${parsed.backendConfigKeys.join(', ')}`);
          }
        });

        it('passes no -backend-config for dynamodb_table', () => {
          assert.ok(!parsed.backendConfigKeys.includes('dynamodb_table'),
            `${script.file} still passes -backend-config="dynamodb_table=..."`);
          assert.equal(parsed.mentionsDynamodbTable, false,
            `${script.file} still mentions dynamodb_table`);
        });

        it('neither exports nor echoes DDBTABLENAME', () => {
          assert.equal(parsed.exportsDdbTableName, false,
            `${script.file} still exports DDBTABLENAME`);
          assert.equal(parsed.mentionsDdbTableName, false,
            `${script.file} still mentions DDBTABLENAME (an export or a leftover echo)`);
        });

        it('keeps the CI guard that omits the profile backend-config', () => {
          assert.equal(parsed.hasCiGuard, true,
            `${script.file} lost the \`if [ "$CI" != "true" ]\` guard`);
          assert.equal(parsed.hasProfileBackendConfig, true,
            `${script.file} no longer passes a profile backend-config in the non-CI branch`);
        });

        it('still uses -reconfigure and never -migrate-state', () => {
          assert.equal(parsed.hasReconfigure, true,
            `${script.file} lost -reconfigure`);
          assert.equal(parsed.hasMigrateState, false,
            `${script.file} uses -migrate-state, which can prompt destructive state moves; ` +
            'only the locking mechanism changes here');
        });

        it('still runs terraform workspace select -or-create with the unchanged workspace', () => {
          assert.equal(parsed.hasWorkspaceSelect, true,
            `${script.file} no longer runs terraform workspace select -or-create`);
          assert.equal(parsed.workspaceLiteral, script.workspace,
            `${script.file} workspace changed to ${parsed.workspaceLiteral}`);
        });

        it('keeps TF_STATE_KEY byte-for-byte unchanged', () => {
          assert.equal(parsed.stateKeyLiteral, 'terraform_${TF_ENV_SHORT}_school_calendar.tfstate',
            `${script.file} TF_STATE_KEY changed to ${JSON.stringify(parsed.stateKeyLiteral)}; ` +
            'a changed key points terraform at non-existent state and looks like a full-stack create');
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('the tfvars remote-state maps drop dynamodb_table and keep everything else', () => {
    for (const tfvars of TFVARS_FILES) {
      // INVERTED BY TASK-052. This loop used to run over REMOTE_STATE_MAPS -
      // then ['terraform_remote_state_basestack_config'] - and require that map
      // to declare exactly bucket/key/region with non-empty values. TASK-052
      // deleted the variable, its data source and this tfvars key together, so
      // REMOTE_STATE_MAPS is now empty and the loop body no longer runs. The
      // assertion is replaced, not dropped: each REMOVED map must be absent.
      for (const mapName of REMOVED_REMOTE_STATE_MAPS) {
        it(`${tfvars} :: declares no ${mapName} map at all`, () => {
          const content = readTf(...tfvars.split('/'));
          assert.ok(!extractMapLiteral(maskCommentsOnly(content), mapName),
            `${tfvars} still declares a ${mapName} map, but its variable declaration was removed - ` +
            'terraform would warn "Value for undeclared variable"');
        });
      }

      it(`${tfvars} :: carries no remote-state config map of any name`, () => {
        const content = maskCommentsOnly(readTf(...tfvars.split('/')));
        assert.ok(!/terraform_remote_state\w*\s*=/.test(content),
          `${tfvars} still assigns a terraform_remote_state* map; this stack reads no remote state`);
      });

      it(`${tfvars} does not mention dynamodb_table at all`, () => {
        const content = readTf(...tfvars.split('/'));
        assert.ok(!maskCommentsAndStrings(content).includes('dynamodb_table'),
          `${tfvars} still declares a dynamodb_table key`);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('the application DynamoDB tables are out of scope and untouched', () => {
    const APP_TABLE_FILES = ['dynamodb_calendar_connections.tf', 'dynamodb_calendar_events.tf'];

    for (const file of APP_TABLE_FILES) {
      it(`${file} still declares its aws_dynamodb_table resource`, () => {
        const content = readTf(file);
        assert.match(content, /resource\s+"aws_dynamodb_table"\s+"calendar_(connections|events)"/,
          `${file} no longer declares its aws_dynamodb_table resource`);
      });

      it(`${file} was not dragged into the locking change`, () => {
        const content = readTf(file);
        assert.ok(!content.includes('use_lockfile'),
          `${file} mentions use_lockfile; the backend change must not leak into an application table`);
      });
    }

    it('the only aws_dynamodb_table resources in terraform/ are the two application tables', () => {
      const names = [];
      for (const file of fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf'))) {
        const code = maskCommentsOnly(readTf(file));
        const RESOURCE = /resource\s+"aws_dynamodb_table"\s+"([A-Za-z0-9_-]+)"/g;
        let m;
        while ((m = RESOURCE.exec(code)) !== null) names.push(m[1]);
      }
      assert.deepEqual(names.sort(), ['calendar_connections', 'calendar_events'],
        `unexpected aws_dynamodb_table resources in terraform/: ${names.join(', ')}. ` +
        'This ticket must neither add nor remove a table resource.');
    });

    it('no terraform file or init script anywhere uses -migrate-state', () => {
      const offenders = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(tf|tfvars|sh)$/.test(entry.name)) {
            if (fs.readFileSync(full, 'utf-8').includes('-migrate-state')) {
              offenders.push(path.relative(PROJECT_ROOT, full));
            }
          }
        }
      };
      walk(TERRAFORM_DIR);
      assert.deepEqual(offenders, [],
        `-migrate-state must not appear anywhere; found in: ${offenders.join(', ')}`);
    });
  });

  // -------------------------------------------------------------------------
  // Failure/edge paths for the assertions themselves. If these ever pass with
  // a deliberately broken fixture, the checks above prove nothing.
  // -------------------------------------------------------------------------
  describe('the assertions above are discriminating (mutated fixtures)', () => {
    const OLD_STYLE_BACKEND = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.19"
    }
  }
  backend "s3" {
    encrypt        = true
    dynamodb_table = "tfstate-table"
  }
}
`;

    it('detects a backend that still uses a DynamoDB lock table', () => {
      const body = extractBackendS3Block(OLD_STYLE_BACKEND);
      assert.ok(body, 'the fixture backend block should still be extractable');
      const assignments = parseAssignments(body);
      assert.ok(assignments.has('dynamodb_table'),
        'the old-style fixture must be seen as still declaring dynamodb_table, ' +
        'otherwise the real assertion could never fail');
      assert.ok(!assignments.has('use_lockfile'),
        'the old-style fixture must be seen as missing use_lockfile');
    });

    it('detects a terraform block with no required_version at all', () => {
      const body = extractTerraformBlock(OLD_STYLE_BACKEND);
      const assignments = parseAssignments(body);
      assert.equal(assignments.get('required_version'), undefined,
        'a terraform block with no required_version must be seen as having none');
    });

    it('does not count a commented-out dynamodb_table as a live reference', () => {
      const commented = '\nbackend "s3" {\n  # dynamodb_table = "tfstate-table"\n  use_lockfile = true\n}\n';
      assert.ok(!maskCommentsAndStrings(commented).includes('dynamodb_table'),
        'a commented-out key must not be read as code');
      const assignments = parseAssignments(extractBackendS3Block(commented));
      assert.deepEqual([...assignments.keys()], ['use_lockfile']);
    });

    it('DOES still count a real dynamodb_table sitting next to a comment mentioning it', () => {
      const sneaky = '\nbackend "s3" {\n  # the dynamodb_table is gone now\n  dynamodb_table = "tfstate-table"\n}\n';
      assert.ok(maskCommentsAndStrings(sneaky).includes('dynamodb_table'),
        'masking comments must not also hide a genuine code reference');
    });

    it('flags an init script that still passes the lock table backend-config', () => {
      const oldScript = [
        'export DDBTABLENAME="tfstate-table"',
        'INIT_CMD="terraform init -reconfigure -backend=true"',
        'INIT_CMD="$INIT_CMD -backend-config=\\"bucket=$AWS_REGION-$BUCKETNAME\\""',
        'INIT_CMD="$INIT_CMD -backend-config=\\"dynamodb_table=$AWS_REGION-$DDBTABLENAME\\""'
      ].join('\n');
      const parsed = parseInitScript(oldScript);
      assert.ok(parsed.backendConfigKeys.includes('dynamodb_table'),
        'the old-style init script must be seen as passing a dynamodb_table backend-config');
      assert.equal(parsed.exportsDdbTableName, true,
        'the old-style init script must be seen as exporting DDBTABLENAME');
    });

    it('flags a tfvars map that still carries the inert dynamodb_table key', () => {
      const oldTfvars = [
        'terraform_remote_state_basestack_config = {',
        '  region         = "ap-southeast-2"',
        '  bucket         = "some-bucket"',
        '  key            = "some.tfstate"',
        '  dynamodb_table = "tfstate-table"',
        '}'
      ].join('\n');
      const keys = [...parseAssignments(
        extractMapLiteral(oldTfvars, 'terraform_remote_state_basestack_config')).keys()].sort();
      assert.deepEqual(keys, ['bucket', 'dynamodb_table', 'key', 'region'],
        'the old-style tfvars map must be seen as still declaring dynamodb_table');
    });

    it('constraintAllows refuses a constraint it cannot reason about instead of passing it', () => {
      assert.throws(() => constraintAllows('probably fine', '1.16.0'), /unrecognised constraint term/,
        'an unparseable constraint must throw, never quietly evaluate to true');
      assert.throws(() => constraintAllows('', '1.16.0'), /empty constraint/);
    });

    it('constraintAllows models ~> correctly for the aws provider bound', () => {
      assert.equal(constraintAllows('~> 6.19', '6.19.0'), true);
      assert.equal(constraintAllows('~> 6.19', '6.44.2'), true);
      assert.equal(constraintAllows('~> 6.19', '6.18.9'), false, '6.18.9 is below the 6.19 floor');
      assert.equal(constraintAllows('~> 6.19', '7.0.0'), false, '~> 6.19 must exclude the next major');
    });
  });
});

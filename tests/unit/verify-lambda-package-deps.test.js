import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseArgs, readDependencyNames, findMissingDependencies, run } from '../../scripts/verify-lambda-package-deps.mjs';

describe('verify-lambda-package-deps unit tests', () => {
  describe('Feature: Argument parsing', () => {
    describe('parseArgs', () => {
      it('Given no arguments, When parseArgs is called, Then it returns an error', () => {
        const result = parseArgs([]);
        assert.strictEqual(result.error, 'missing required argument <lambda-dir>');
        assert.strictEqual(result.lambdaDir, undefined);
      });

      it('Given a single argument, When parseArgs is called, Then it returns that argument as lambdaDir', () => {
        const result = parseArgs(['../src/lambda/calendar']);
        assert.strictEqual(result.lambdaDir, '../src/lambda/calendar');
        assert.strictEqual(result.error, undefined);
      });

      it('Given more than one argument, When parseArgs is called, Then it returns an error', () => {
        const result = parseArgs(['dir1', 'dir2']);
        assert.ok(result.error);
        assert.match(result.error, /unexpected extra argument/);
      });

      it('Given --help flag, When parseArgs is called, Then it returns help=true', () => {
        const result = parseArgs(['--help']);
        assert.strictEqual(result.help, true);
        assert.strictEqual(result.lambdaDir, undefined);
      });

      it('Given -h flag, When parseArgs is called, Then it returns help=true', () => {
        const result = parseArgs(['-h']);
        assert.strictEqual(result.help, true);
      });
    });
  });

  describe('Feature: Dependency name extraction', () => {
    describe('readDependencyNames', () => {
      it('Given a valid package.json with dependencies, When readDependencyNames is called, Then it returns the dependency names', () => {
        const json = JSON.stringify({
          name: 'test',
          dependencies: {
            '@anthropic-ai/sdk': '^0.117.1',
            'zod': '^4.4.3'
          }
        });
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => json
        });
        assert.deepStrictEqual(result.names, ['@anthropic-ai/sdk', 'zod']);
        assert.strictEqual(result.error, undefined);
      });

      it('Given a package.json with no dependencies block, When readDependencyNames is called, Then it returns an empty array', () => {
        const json = JSON.stringify({ name: 'test' });
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => json
        });
        assert.deepStrictEqual(result.names, []);
        assert.strictEqual(result.error, undefined);
      });

      it('Given a package.json with empty dependencies block, When readDependencyNames is called, Then it returns an empty array', () => {
        const json = JSON.stringify({
          name: 'test',
          dependencies: {}
        });
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => json
        });
        assert.deepStrictEqual(result.names, []);
        assert.strictEqual(result.error, undefined);
      });

      it('Given malformed JSON in package.json, When readDependencyNames is called, Then it returns an error', () => {
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => '{ invalid json'
        });
        assert.ok(result.error);
        assert.match(result.error, /not valid JSON/);
      });

      it('Given a missing package.json file, When readDependencyNames is called, Then it returns an error', () => {
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => {
            throw new Error('ENOENT: no such file or directory');
          }
        });
        assert.ok(result.error);
        assert.match(result.error, /could not read/);
      });

      it('Given dependencies that is not an object, When readDependencyNames is called, Then it returns an empty array', () => {
        const json = JSON.stringify({
          name: 'test',
          dependencies: 'not-an-object'
        });
        const result = readDependencyNames('/path/to/package.json', {
          readFile: () => json
        });
        assert.deepStrictEqual(result.names, []);
      });
    });
  });

  describe('Feature: Missing dependency detection', () => {
    describe('findMissingDependencies', () => {
      it('Given all declared dependencies exist in node_modules, When findMissingDependencies is called, Then it returns an empty array', () => {
        const result = findMissingDependencies({
          lambdaDir: '/lambda',
          dependencyNames: ['pkg1', 'pkg2'],
          dirExists: (checkPath) => {
            return checkPath.endsWith('pkg1') || checkPath.endsWith('pkg2');
          }
        });
        assert.deepStrictEqual(result, []);
      });

      it('Given one declared dependency missing from node_modules, When findMissingDependencies is called, Then it returns that dependency name', () => {
        const result = findMissingDependencies({
          lambdaDir: '/lambda',
          dependencyNames: ['pkg1', 'pkg2'],
          dirExists: (checkPath) => checkPath.endsWith('pkg1')
        });
        assert.deepStrictEqual(result, ['pkg2']);
      });

      it('Given all declared dependencies missing from node_modules, When findMissingDependencies is called, Then it returns all dependency names', () => {
        const result = findMissingDependencies({
          lambdaDir: '/lambda',
          dependencyNames: ['pkg1', 'pkg2', 'pkg3'],
          dirExists: () => false
        });
        assert.deepStrictEqual(result, ['pkg1', 'pkg2', 'pkg3']);
      });

      it('Given no declared dependencies, When findMissingDependencies is called, Then it returns an empty array', () => {
        const result = findMissingDependencies({
          lambdaDir: '/lambda',
          dependencyNames: [],
          dirExists: () => true
        });
        assert.deepStrictEqual(result, []);
      });

      it('Given missing dependencies, Then they are returned in declaration order', () => {
        const result = findMissingDependencies({
          lambdaDir: '/lambda',
          dependencyNames: ['z-last', 'a-first', 'm-middle'],
          dirExists: () => false
        });
        assert.deepStrictEqual(result, ['z-last', 'a-first', 'm-middle']);
      });
    });
  });

  describe('Feature: Integration - run function', () => {
    it('Given all dependencies present, When run is called, Then it returns exit code 0', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({
          name: 'test',
          dependencies: { '@anthropic-ai/sdk': '^0.117.1', 'zod': '^4.4.3' }
        }),
        dirExists: (checkPath) => {
          // Always return true - all packages exist
          return true;
        }
      });
      assert.strictEqual(code, 0, `Expected exit code 0 but got ${code}. Logs: ${logs.join('\n')}`);
      assert.ok(logs.some(line => line.includes('PASS')));
    });

    it('Given one missing dependency, When run is called, Then it returns exit code 1 and names the missing package', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({
          name: 'test',
          dependencies: { '@anthropic-ai/sdk': '^0.117.1', 'zod': '^4.4.3' }
        }),
        dirExists: (checkPath) => checkPath.endsWith('node_modules/zod')
      });
      assert.strictEqual(code, 1);
      const failLog = logs.find(line => line.includes('FAIL'));
      assert.ok(failLog);
      assert.ok(failLog.includes('@anthropic-ai/sdk'));
    });

    it('Given multiple missing dependencies, When run is called, Then it returns exit code 1 and names all missing packages', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({
          name: 'test',
          dependencies: { '@anthropic-ai/sdk': '^0.117.1', 'zod': '^4.4.3' }
        }),
        dirExists: () => false
      });
      assert.strictEqual(code, 1);
      const failLog = logs.find(line => line.includes('FAIL'));
      assert.ok(failLog);
      assert.ok(failLog.includes('@anthropic-ai/sdk'));
      assert.ok(failLog.includes('zod'));
    });

    it('Given malformed package.json, When run is called, Then it returns exit code 1', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => '{ bad json'
      });
      assert.strictEqual(code, 1);
      assert.ok(logs.some(line => line.includes('FAIL')));
    });

    it('Given a package.json with no dependencies, When run is called, Then it returns exit code 0 with a message', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({ name: 'test' })
      });
      assert.strictEqual(code, 0);
      assert.ok(logs.some(line => line.includes('declares no runtime dependencies')));
    });

    it('Given --help flag, When run is called, Then it returns exit code 0 and logs usage', async () => {
      const logs = [];
      const code = await run({
        argv: ['--help'],
        log: (line) => logs.push(line)
      });
      assert.strictEqual(code, 0);
      assert.ok(logs.some(line => line.includes('Usage:')));
    });

    it('Given no arguments, When run is called, Then it returns exit code 1 and logs error', async () => {
      const logs = [];
      const code = await run({
        argv: [],
        log: (line) => logs.push(line)
      });
      assert.strictEqual(code, 1);
      assert.ok(logs.some(line => line.includes('error')));
    });

    it('When a declared dependency message is logged, Then it lists every declared dependency name', async () => {
      const logs = [];
      const code = await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({
          name: 'test',
          dependencies: { 'pkg-alpha': '1.0.0', 'pkg-beta': '2.0.0' }
        }),
        dirExists: () => true
      });
      assert.strictEqual(code, 0);
      const passLog = logs.find(line => line.includes('PASS'));
      assert.ok(passLog.includes('pkg-alpha'));
      assert.ok(passLog.includes('pkg-beta'));
    });
  });

  describe('Feature: Fail-loud guarantees', () => {
    it('Given a broken manifest, When run is called, Then it does not exit 0', async () => {
      const code = await run({
        argv: ['/lambda'],
        log: () => {},
        readFile: () => 'not json at all'
      });
      assert.notStrictEqual(code, 0);
    });

    it('Given missing dependencies, When run is called, Then the exit code is 1 and not silently 0', async () => {
      const code = await run({
        argv: ['/lambda'],
        log: () => {},
        readFile: () => JSON.stringify({
          dependencies: { '@anthropic-ai/sdk': '^0.117.1' }
        }),
        dirExists: () => false
      });
      assert.strictEqual(code, 1);
    });

    it('When dependencies are missing, Then the error message includes the TASK-038 reference', async () => {
      const logs = [];
      await run({
        argv: ['/lambda'],
        log: (line) => logs.push(line),
        readFile: () => JSON.stringify({
          dependencies: { '@anthropic-ai/sdk': '^0.117.1' }
        }),
        dirExists: () => false
      });
      const errorLog = logs.find(line => line.includes('refusing to package'));
      assert.ok(errorLog);
      assert.ok(errorLog.includes('TASK-038'));
    });
  });
});

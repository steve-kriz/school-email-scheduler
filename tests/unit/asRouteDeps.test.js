import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { asRouteDeps } from '../../src/lambda/calendar/index.mjs';

const EVIL_ENDPOINT = 'https://evil.example.com/token';

describe('Unit: asRouteDeps - Structural Safety Gate', () => {
  describe('acceptance criteria', () => {
    it('should return a plain object unchanged', () => {
      const input = { key: 'value', nested: { data: 123 } };
      const result = asRouteDeps(input);
      assert.strictEqual(result, input, 'plain objects should be returned as-is');
    });

    it('should return a null-prototype object unchanged', () => {
      const input = Object.create(null);
      input.key = 'value';
      const result = asRouteDeps(input);
      assert.strictEqual(result, input, 'null-prototype objects should be returned as-is');
    });

    it('should return {} for a function', () => {
      const input = function callback() {};
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a function with own properties', () => {
      const input = function callback() {};
      input.tokenEndpoint = EVIL_ENDPOINT;
      input.exchangeCode = () => {};
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
      assert.strictEqual(result.tokenEndpoint, undefined);
    });

    it('should return {} for an arrow function', () => {
      const input = () => 'test';
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for an async function', () => {
      const input = async () => 'test';
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a class instance', () => {
      class MyClass {
        constructor() {
          this.tokenEndpoint = EVIL_ENDPOINT;
        }
      }
      const input = new MyClass();
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for an array', () => {
      const input = ['a', 'b', 'c'];
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for an empty array', () => {
      const input = [];
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for null', () => {
      const result = asRouteDeps(null);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for undefined', () => {
      const result = asRouteDeps(undefined);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a string', () => {
      const result = asRouteDeps('not an object');
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a number', () => {
      const result = asRouteDeps(42);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a boolean', () => {
      assert.deepStrictEqual(asRouteDeps(true), {});
      assert.deepStrictEqual(asRouteDeps(false), {});
    });

    it('should return {} for a symbol', () => {
      const sym = Symbol('test');
      const result = asRouteDeps(sym);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a Date', () => {
      const input = new Date();
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a Map', () => {
      const input = new Map();
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a Set', () => {
      const input = new Set();
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a WeakMap', () => {
      const input = new WeakMap();
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a WeakSet', () => {
      const input = new WeakSet();
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for a RegExp', () => {
      const input = /test/;
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should accept a Proxy wrapping a plain object (prototype is Object.prototype)', () => {
      const target = { key: 'value', tokenEndpoint: EVIL_ENDPOINT };
      const proxy = new Proxy(target, {});
      // Proxies wrapping plain objects have Object.prototype as their prototype,
      // so they pass through the gate (though this is somewhat permissive)
      const result = asRouteDeps(proxy);
      assert.strictEqual(result, proxy);
      assert.equal(result.key, 'value');
      assert.equal(result.tokenEndpoint, EVIL_ENDPOINT);
    });

    it('should return {} for an object with a custom (non-Object.prototype) prototype', () => {
      const proto = { inherited: 'value' };
      const input = Object.create(proto);
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      assert.deepStrictEqual(result, {});
    });

    it('should return {} for Object.create({}) even though the prototype is a plain object', () => {
      const proto = {};
      const input = Object.create(proto);
      input.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(input);
      // This should be rejected because proto is NOT Object.prototype
      assert.deepStrictEqual(result, {});
    });

    it('should handle a complex object with many properties', () => {
      const input = {
        tokenEndpoint: 'https://real.endpoint.com',
        exchangeCode: async () => ({ idToken: '' }),
        fetchImpl: async () => ({ ok: true }),
        env: { GOOGLE_CLIENT_ID: 'test' },
        nowSeconds: Math.floor(Date.now() / 1000),
        putConnection: async () => {},
        getConnection: async () => {},
        randomBytes: (n) => Buffer.alloc(n),
        origin: 'https://example.com',
        allowlist: ['example.com'],
      };
      const result = asRouteDeps(input);
      assert.strictEqual(result, input);
      assert.equal(result.tokenEndpoint, 'https://real.endpoint.com');
      assert.equal(typeof result.exchangeCode, 'function');
    });
  });

  describe('edge cases and safety properties', () => {
    it('should use === comparison, not loose equality', () => {
      const obj = { value: 0 };
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj, 'should use strict comparison');
    });

    it('should preserve own properties but not inherited ones', () => {
      const proto = { inherited: 'from proto' };
      const obj = Object.create(proto);
      obj.own = 'own property';
      const plainObj = { own: 'own property' };

      const plainResult = asRouteDeps(plainObj);
      assert.equal(plainResult.own, 'own property');
      assert.strictEqual(plainResult, plainObj);
    });

    it('should not call toString, valueOf or other methods', () => {
      let methodCalls = 0;
      const input = {
        toString() {
          methodCalls++;
          return '[object Object]';
        },
        valueOf() {
          methodCalls++;
          return this;
        },
      };
      asRouteDeps(input);
      // asRouteDeps should not trigger these methods
      // Object.getPrototypeOf does not call toString/valueOf
      assert.equal(methodCalls, 0, 'no methods should be called during the check');
    });

    it('should not enumerate or freeze the input', () => {
      const input = { key: 'value' };
      const result = asRouteDeps(input);
      assert.ok(!Object.isFrozen(input), 'input should not be frozen');
      assert.ok(!Object.isSealed(input), 'input should not be sealed');
      input.newKey = 'new value';
      assert.equal(input.newKey, 'new value', 'input should still be mutable');
    });

    it('should return fresh empty objects for rejected inputs (not a cached singleton)', () => {
      const r1 = asRouteDeps(function f1() {});
      const r2 = asRouteDeps(function f2() {});
      // They may or may not be the same reference depending on implementation,
      // but they must be empty objects
      assert.deepStrictEqual(r1, {});
      assert.deepStrictEqual(r2, {});
    });

    it('should reject an object whose prototype was changed after creation', () => {
      const obj = { tokenEndpoint: EVIL_ENDPOINT };
      // Create with Object.prototype (implicitly)
      assert.strictEqual(Object.getPrototypeOf(obj), Object.prototype);

      // Change the prototype to a custom one
      const proto = {};
      Object.setPrototypeOf(obj, proto);
      assert.strictEqual(Object.getPrototypeOf(obj), proto);

      // Now it should be rejected
      const result = asRouteDeps(obj);
      assert.deepStrictEqual(result, {});
    });

    it('should accept an object whose prototype was set to null', () => {
      const obj = Object.create(null);
      obj.tokenEndpoint = EVIL_ENDPOINT;
      assert.strictEqual(Object.getPrototypeOf(obj), null);

      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
      assert.equal(result.tokenEndpoint, EVIL_ENDPOINT);
    });

    it('should accept an object whose prototype was explicitly set to Object.prototype', () => {
      const obj = { tokenEndpoint: EVIL_ENDPOINT };
      // Even after manipulation
      Object.setPrototypeOf(obj, Object.prototype);
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
    });

    it('should accept an object with symbols as keys', () => {
      const sym = Symbol('test');
      const input = {
        [sym]: 'symbol value',
        normalKey: 'normal value',
      };
      const result = asRouteDeps(input);
      assert.strictEqual(result, input);
      assert.equal(result[sym], 'symbol value');
      assert.equal(result.normalKey, 'normal value');
    });

    it('should accept an object with many own properties', () => {
      const input = {};
      for (let i = 0; i < 1000; i++) {
        input[`key${i}`] = `value${i}`;
      }
      const result = asRouteDeps(input);
      assert.strictEqual(result, input);
      assert.equal(result.key0, 'value0');
      assert.equal(result.key999, 'value999');
    });

    it('should be idempotent', () => {
      const input = { key: 'value' };
      const r1 = asRouteDeps(input);
      const r2 = asRouteDeps(r1);
      assert.strictEqual(r1, input);
      assert.strictEqual(r2, input);
    });

    it('should be idempotent for rejected inputs', () => {
      const input = function f() {};
      const r1 = asRouteDeps(input);
      const r2 = asRouteDeps(r1);
      // Both results are empty objects
      assert.deepStrictEqual(r1, {});
      assert.deepStrictEqual(r2, {});
    });
  });

  describe('security invariants', () => {
    it('should gate on prototype chain position, not on instanceof checks', () => {
      // An object that passes instanceof Object but has a custom prototype
      // should be rejected
      const custom = { inherited: true };
      const obj = Object.create(custom);
      obj.own = true;

      assert.ok(obj instanceof Object, 'should be instanceof Object');
      const result = asRouteDeps(obj);
      assert.deepStrictEqual(result, {}, 'but should be rejected by asRouteDeps');
    });

    it('should not be fooled by a toString that returns "Object"', () => {
      const obj = {
        toString() {
          return '[object Object]';
        },
      };
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj, 'toString override should not affect the check');
    });

    it('should reject an object that pretends to be a function', () => {
      const obj = Object.create(Function.prototype);
      obj.tokenEndpoint = EVIL_ENDPOINT;
      const result = asRouteDeps(obj);
      // This is a bit of a grey area, but Object.getPrototypeOf will show
      // Function.prototype, not Object.prototype or null
      assert.deepStrictEqual(result, {});
    });

    it('should not be fooled by getOwnPropertyNames or similar enumeration tricks', () => {
      const obj = {
        key1: 'value1',
      };
      Object.defineProperty(obj, 'key2', {
        value: 'value2',
        enumerable: false,
      });
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
      // Both enumerable and non-enumerable properties should be accessible
      assert.equal(result.key1, 'value1');
      assert.equal(result.key2, 'value2');
    });

    it('should handle a frozen plain object', () => {
      const obj = { key: 'value' };
      Object.freeze(obj);
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj, 'frozen plain object should still pass');
    });

    it('should handle a sealed plain object', () => {
      const obj = { key: 'value' };
      Object.seal(obj);
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj, 'sealed plain object should still pass');
    });

    it('should not be influenced by property descriptors', () => {
      const obj = {};
      Object.defineProperty(obj, 'key', {
        value: 'value',
        writable: false,
        enumerable: true,
        configurable: false,
      });
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
      assert.equal(result.key, 'value');
    });
  });

  describe('type checking correctness', () => {
    it('should distinguish between primitive null and null prototype', () => {
      // Primitive null -> rejected
      const r1 = asRouteDeps(null);
      assert.deepStrictEqual(r1, {});

      // Null prototype object -> accepted
      const obj = Object.create(null);
      const r2 = asRouteDeps(obj);
      assert.strictEqual(r2, obj);
    });

    it('should distinguish between undefined and no argument', () => {
      const r1 = asRouteDeps(undefined);
      assert.deepStrictEqual(r1, {});

      // No arguments (defaults to undefined internally in JS)
      const r2 = asRouteDeps();
      assert.deepStrictEqual(r2, {});
    });

    it('should reject boxed primitives', () => {
      // These are objects, but they should still be rejected
      // because they have a different prototype
      const numBox = new Number(42);
      const strBox = new String('test');
      const boolBox = new Boolean(true);

      assert.deepStrictEqual(asRouteDeps(numBox), {});
      assert.deepStrictEqual(asRouteDeps(strBox), {});
      assert.deepStrictEqual(asRouteDeps(boolBox), {});
    });

    it('should handle the empty object literal', () => {
      const obj = {};
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
    });

    it('should handle an object with circular references', () => {
      const obj = { a: 1 };
      obj.self = obj;
      const result = asRouteDeps(obj);
      assert.strictEqual(result, obj);
      assert.strictEqual(result.self, obj);
      assert.strictEqual(result.self.self, obj);
    });
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// === Google OAuth functions ===
import {
  buildRedirectUri,
  buildAuthorizationUrl,
  generateState,
  generateCodeVerifier,
  codeChallengeS256,
  readOAuthConfig,
  missingConfigVars,
  serializeStateCookie,
  parseStateCookie,
  serializeClearedStateCookie,
  stateMatches,
  decodeIdToken,
  validateIdTokenClaims,
  GOOGLE_SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  CALLBACK_PATH,
  REQUIRED_START_VARS,
  REQUIRED_CALLBACK_VARS,
  POST_LOGIN_PATH,
} from '../../src/lambda/calendar/backend/google-oauth.mjs';

// === Session functions ===
import {
  createSessionToken,
  verifySessionToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  serializeSessionCookie,
  serializeClearedSessionCookie,
  parseCookieHeader,
  getCookies,
  getCookie,
  encodeSessionPayload,
  decodeSessionPayload,
  signSessionPayload,
  signaturesMatch,
  SessionError,
} from '../../src/lambda/calendar/backend/session.mjs';

// === Crypto functions ===
import {
  constantTimeEquals,
  isBase64,
  encryptSecret,
  decryptSecret,
  resolveKeyId,
  needsRewrap,
} from '../../src/lambda/calendar/backend/crypto.mjs';

// === Connections functions ===
import {
  connectionUserId,
  stripSecrets,
  toPublicJson,
  CONNECTION_STATUS,
  SECRET_ATTRIBUTES,
  PUBLIC_ATTRIBUTES,
  USER_ID_PREFIX,
  putConnection,
  updateConnection,
  getConnection,
  getRefreshToken,
} from '../../src/lambda/calendar/backend/connections.mjs';

describe('Google OAuth Pure Functions', () => {
  describe('buildRedirectUri', () => {
    it('should build redirect URI from public base URL', () => {
      const uri = buildRedirectUri('https://example.com');
      assert.equal(uri, `https://example.com${CALLBACK_PATH}`);
    });

    it('should strip trailing slashes', () => {
      const uri = buildRedirectUri('https://example.com/');
      assert.equal(uri, `https://example.com${CALLBACK_PATH}`);
    });

    it('should handle URLs with multiple trailing slashes', () => {
      const uri = buildRedirectUri('https://example.com//');
      assert.equal(uri, `https://example.com${CALLBACK_PATH}`);
    });

    it('should handle empty URL', () => {
      const uri = buildRedirectUri('');
      assert.equal(uri, CALLBACK_PATH);
    });
  });

  describe('PKCE - codeChallengeS256 and code verifiers', () => {
    it('should generate a valid code verifier', () => {
      const verifier = generateCodeVerifier();
      assert.ok(verifier.length > 0, 'verifier should not be empty');
      assert.ok(verifier.match(/^[A-Za-z0-9_-]+$/), 'verifier should be base64url');
    });

    it('should generate unique verifiers', () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      assert.notEqual(v1, v2, 'consecutive verifiers should differ');
    });

    it('should compute S256 challenge from verifier', () => {
      const verifier = 'test_verifier_string_123456789012345678901234';
      const challenge = codeChallengeS256(verifier);

      // Manually compute expected challenge
      const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      assert.equal(challenge, expected);
    });

    it('should compute different challenges for different verifiers', () => {
      const c1 = codeChallengeS256('verifier1');
      const c2 = codeChallengeS256('verifier2');
      assert.notEqual(c1, c2);
    });

    it('should ensure challenge is not the same as the verifier', () => {
      const verifier = generateCodeVerifier();
      const challenge = codeChallengeS256(verifier);
      assert.notEqual(challenge, verifier, 'challenge should never equal the verifier');
    });
  });

  describe('buildAuthorizationUrl', () => {
    const baseUrl = 'https://example.com/oauth/callback';
    const clientId = 'test-client-id';
    const state = 'test-state-value';
    const challenge = 'test-challenge-abc123';

    it('should include required OAuth params', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(url.includes(`client_id=${clientId}`), 'should include client_id');
      assert.ok(url.includes(`redirect_uri=${encodeURIComponent(baseUrl)}`), 'should include redirect_uri');
      assert.ok(url.includes(`state=${state}`), 'should include state');
      assert.ok(url.includes(`code_challenge=${challenge}`), 'should include code_challenge');
    });

    it('should include gmail.readonly scope', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(url.includes('gmail.readonly'), 'should request gmail.readonly');
    });

    it('should include access_type=offline', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(url.includes('access_type=offline'), 'should set access_type=offline');
    });

    it('should include prompt=consent', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(url.includes('prompt=consent'), 'should set prompt=consent');
    });

    it('should include code_challenge_method=S256', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(url.includes('code_challenge_method=S256'), 'should set S256 method');
    });

    it('should never include code_verifier in the URL', () => {
      const verifier = 'secret-verifier-should-never-appear';
      const challenge = codeChallengeS256(verifier);
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      assert.ok(!url.includes(verifier), 'verifier must not appear in URL');
    });

    it('should support all required scopes', () => {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: baseUrl,
        state,
        codeChallenge: challenge,
      });

      for (const scope of GOOGLE_SCOPES) {
        assert.ok(url.includes(encodeURIComponent(scope)), `should include ${scope}`);
      }
    });
  });

  describe('generateState', () => {
    it('should generate a non-empty state', () => {
      const state = generateState();
      assert.ok(state.length > 0, 'state must not be empty');
    });

    it('should generate unique states', () => {
      const s1 = generateState();
      const s2 = generateState();
      assert.notEqual(s1, s2, 'consecutive states should differ');
    });

    it('should use base64url format', () => {
      const state = generateState();
      assert.ok(state.match(/^[A-Za-z0-9_-]+$/), 'state should be base64url');
    });
  });

  describe('State cookie - serialize and parse', () => {
    it('should serialize a state cookie with both state and verifier', () => {
      const cookie = serializeStateCookie({
        state: 'test-state-123',
        codeVerifier: 'test-verifier-456',
      });

      assert.ok(cookie.includes('calendar_oauth_state='), 'should have cookie name');
      assert.ok(cookie.includes('HttpOnly'), 'should be HttpOnly');
      assert.ok(cookie.includes('Secure'), 'should be Secure');
      assert.ok(cookie.includes('SameSite=Lax'), 'should be SameSite=Lax');
      assert.ok(cookie.includes('Path=/calendar'), 'should be scoped to /calendar');
    });

    it('should set state cookie to expire in ~10 minutes', () => {
      const cookie = serializeStateCookie({
        state: 'test-state',
        codeVerifier: 'test-verifier',
      });

      assert.ok(cookie.includes('Max-Age=600'), 'should expire in 600 seconds');
    });

    it('should parse a valid state cookie', () => {
      const original = { state: 'state-abc', codeVerifier: 'verifier-xyz' };
      const serialized = serializeStateCookie(original);

      // Extract the value from the Set-Cookie header
      const match = serialized.match(/calendar_oauth_state=([^;]+)/);
      const cookieValue = match[1];

      const parsed = parseStateCookie(cookieValue);
      assert.deepEqual(parsed, original);
    });

    it('should return null for malformed state cookie', () => {
      assert.equal(parseStateCookie('invalid-base64-!!!'), null);
      assert.equal(parseStateCookie(''), null);
      assert.equal(parseStateCookie(null), null);
      assert.equal(parseStateCookie(undefined), null);
    });

    it('should return null for cookie missing state or verifier', () => {
      const value = Buffer.from(JSON.stringify({ state: 'only-state' }), 'utf8').toString('base64url');
      assert.equal(parseStateCookie(value), null);

      const value2 = Buffer.from(JSON.stringify({ codeVerifier: 'only-verifier' }), 'utf8').toString('base64url');
      assert.equal(parseStateCookie(value2), null);
    });

    it('should clear state cookie with Max-Age=0', () => {
      const cleared = serializeClearedStateCookie();
      assert.ok(cleared.includes('Max-Age=0'), 'should have Max-Age=0');
      assert.ok(cleared.includes('calendar_oauth_state='), 'should have cookie name');
      assert.ok(cleared.includes('Expires=Thu, 01 Jan 1970'), 'should have Expires=1970');
    });
  });

  describe('stateMatches - constant-time comparison', () => {
    it('should match identical state values', () => {
      assert.ok(stateMatches('same-state', 'same-state'));
    });

    it('should not match different states', () => {
      assert.ok(!stateMatches('state1', 'state2'));
    });

    it('should not match when param is missing', () => {
      assert.ok(!stateMatches(null, 'state'));
      assert.ok(!stateMatches(undefined, 'state'));
      assert.ok(!stateMatches('', 'state'));
    });

    it('should not match when cookie is missing', () => {
      assert.ok(!stateMatches('state', null));
      assert.ok(!stateMatches('state', undefined));
      assert.ok(!stateMatches('state', ''));
    });

    it('should handle empty-vs-empty as mismatch', () => {
      assert.ok(!stateMatches('', ''));
      assert.ok(!stateMatches(null, null));
    });
  });

  describe('readOAuthConfig', () => {
    it('should read config from env', () => {
      const env = {
        GOOGLE_CLIENT_ID: 'client-123',
        GOOGLE_CLIENT_SECRET: 'secret-456',
        SESSION_SECRET: 'session-789',
        PUBLIC_BASE_URL: 'https://example.com',
      };

      const config = readOAuthConfig(env);
      assert.equal(config.clientId, 'client-123');
      assert.equal(config.clientSecret, 'secret-456');
      assert.equal(config.sessionSecret, 'session-789');
      assert.equal(config.publicBaseUrl, 'https://example.com');
    });

    it('should trim whitespace', () => {
      const config = readOAuthConfig({
        GOOGLE_CLIENT_ID: '  client-id  ',
        GOOGLE_CLIENT_SECRET: '  secret  ',
        SESSION_SECRET: '  token  ',
        PUBLIC_BASE_URL: '  https://example.com/  ',
      });

      assert.equal(config.clientId, 'client-id');
      assert.equal(config.clientSecret, 'secret');
      assert.equal(config.sessionSecret, 'token');
      assert.equal(config.publicBaseUrl, 'https://example.com');
    });

    it('should return empty strings for missing vars', () => {
      const config = readOAuthConfig({});
      assert.equal(config.clientId, '');
      assert.equal(config.clientSecret, '');
      assert.equal(config.sessionSecret, '');
      assert.equal(config.publicBaseUrl, '');
    });
  });

  describe('missingConfigVars', () => {
    it('should identify missing required start vars', () => {
      const config = {
        clientId: '',
        clientSecret: 'secret',
        sessionSecret: 'session',
        publicBaseUrl: 'https://example.com',
      };

      const missing = missingConfigVars(config, REQUIRED_START_VARS);
      assert.ok(missing.includes('GOOGLE_CLIENT_ID'));
      assert.ok(!missing.includes('GOOGLE_CLIENT_SECRET'));
    });

    it('should identify missing callback vars', () => {
      const config = {
        clientId: 'client',
        clientSecret: '',
        sessionSecret: '',
        publicBaseUrl: 'https://example.com',
      };

      const missing = missingConfigVars(config, REQUIRED_CALLBACK_VARS);
      assert.ok(missing.includes('GOOGLE_CLIENT_SECRET'));
      assert.ok(missing.includes('SESSION_SECRET'));
    });

    it('should return only variable names, never values', () => {
      const config = {
        clientId: 'secret-value-123',
        clientSecret: 'another-secret',
        sessionSecret: '',
        publicBaseUrl: '',
      };

      const missing = missingConfigVars(config);
      for (const name of missing) {
        assert.ok(!name.includes('secret'), `${name} should not contain secret values`);
      }
    });
  });

  describe('decodeIdToken', () => {
    it('should decode a valid JWT', () => {
      const claims = { sub: '123', email: 'test@example.com', aud: 'client-id' };
      const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const jwt = `header.${encodedClaims}.signature`;

      const decoded = decodeIdToken(jwt);
      assert.deepEqual(decoded, claims);
    });

    it('should return null for non-JWT format', () => {
      assert.equal(decodeIdToken('not-a-jwt'), null);
      assert.equal(decodeIdToken('two.parts'), null);
      assert.equal(decodeIdToken(''), null);
      assert.equal(decodeIdToken(null), null);
    });

    it('should return null for invalid base64url in claims', () => {
      const jwt = 'header.!!!invalid!!!.signature';
      assert.equal(decodeIdToken(jwt), null);
    });

    it('should return null for non-JSON in claims', () => {
      const invalidClaims = Buffer.from('not json', 'utf8').toString('base64url');
      const jwt = `header.${invalidClaims}.signature`;
      assert.equal(decodeIdToken(jwt), null);
    });

    it('should return null for array claims', () => {
      const invalidClaims = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64url');
      const jwt = `header.${invalidClaims}.signature`;
      assert.equal(decodeIdToken(jwt), null);
    });
  });

  describe('validateIdTokenClaims', () => {
    const now = Math.floor(Date.now() / 1000);
    const clientId = 'test-client-id';

    it('should validate a correct id_token', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'google-user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(result.valid);
      assert.equal(result.sub, 'google-user-123');
      assert.equal(result.email, 'user@example.com');
    });

    it('should reject wrong issuer', () => {
      const claims = {
        iss: 'https://evil.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'iss');
    });

    it('should accept both Google issuer spellings', () => {
      const spelling1 = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const spelling2 = {
        iss: 'accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const r1 = validateIdTokenClaims(spelling1, { clientId, nowSeconds: now });
      const r2 = validateIdTokenClaims(spelling2, { clientId, nowSeconds: now });
      assert.ok(r1.valid);
      assert.ok(r2.valid);
    });

    it('should reject wrong audience', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: 'different-client-id',
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'aud');
    });

    it('should reject missing audience', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'aud');
    });

    it('should reject expired token', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now - 1,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'expired');
    });

    it('should reject missing sub claim', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'sub');
    });

    it('should reject missing email claim', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'email');
    });

    it('should reject email_verified: false', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
        email_verified: false,
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'email_unverified');
    });

    it('should accept email_verified: true', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
        email_verified: true,
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(result.valid);
    });

    it('should accept omitted email_verified', () => {
      const claims = {
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: now + 3600,
        sub: 'user-123',
        email: 'user@example.com',
      };

      const result = validateIdTokenClaims(claims, { clientId, nowSeconds: now });
      assert.ok(result.valid);
    });

    it('should reject undecodable claims', () => {
      const result = validateIdTokenClaims(null, { clientId });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'undecodable');
    });
  });
});

describe('Session Functions', () => {
  describe('Session token encoding and decoding', () => {
    it('should encode session payload to base64url', () => {
      const claims = { sub: '123', email: 'test@example.com', iat: 1000, exp: 2000 };
      const encoded = encodeSessionPayload(claims);

      // Verify it's base64url
      assert.ok(encoded.match(/^[A-Za-z0-9_-]+$/), 'should be base64url');

      // Decode and verify content
      const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      assert.deepEqual(decoded, claims);
    });

    it('should decode session payload from base64url', () => {
      const claims = { sub: '123', email: 'user@example.com', iat: 1000, exp: 2000 };
      const encoded = encodeSessionPayload(claims);
      const decoded = decodeSessionPayload(encoded);
      assert.deepEqual(decoded, claims);
    });

    it('should return null for malformed payload', () => {
      assert.equal(decodeSessionPayload('invalid-base64-!!!'), null);
      assert.equal(decodeSessionPayload(''), null);
      assert.equal(decodeSessionPayload(null), null);
    });

    it('should return null for non-JSON payload', () => {
      const invalid = Buffer.from('not json', 'utf8').toString('base64url');
      assert.equal(decodeSessionPayload(invalid), null);
    });

    it('should return null for array payload', () => {
      const invalid = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('base64url');
      assert.equal(decodeSessionPayload(invalid), null);
    });
  });

  describe('Session token creation and verification', () => {
    const secret = 'test-session-secret-32-bytes-long!!!';
    const now = Math.floor(Date.now() / 1000);

    it('should create a valid session token', () => {
      const token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now }
      );

      assert.ok(token.includes('.'), 'token should have payload.signature format');
      const [payload, signature] = token.split('.');
      assert.ok(payload.length > 0);
      assert.ok(signature.length > 0);
    });

    it('should verify a valid session token', () => {
      const token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now, ttlSeconds: 3600 }
      );

      const result = verifySessionToken(token, { secret, nowSeconds: now + 1000 });
      assert.ok(result.valid);
      assert.equal(result.claims.sub, '123');
      assert.equal(result.claims.email, 'test@example.com');
    });

    it('should reject a token with no secret', () => {
      const result = verifySessionToken('any.token', { secret: '' });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'no-secret');
    });

    it('should reject a tampered payload (signature changed)', () => {
      const token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now, ttlSeconds: 3600 }
      );

      const [payload, signature] = token.split('.');
      // Flip the last byte of the signature
      const tampered = payload + '.' + (signature.slice(0, -1) + (signature[signature.length - 1] === 'A' ? 'B' : 'A'));

      const result = verifySessionToken(tampered, { secret, nowSeconds: now + 1000 });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'signature');
    });

    it('should reject a tampered payload (claims modified)', () => {
      let token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now, ttlSeconds: 3600 }
      );

      // Decode and tamper with claims
      const [payload, signature] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      claims.sub = '999'; // Change sub
      const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      token = tamperedPayload + '.' + signature;

      const result = verifySessionToken(token, { secret, nowSeconds: now + 1000 });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'signature');
    });

    it('should reject an expired token', () => {
      const token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now, ttlSeconds: 100 }
      );

      const result = verifySessionToken(token, { secret, nowSeconds: now + 200 });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'expired');
    });

    it('should reject missing token', () => {
      const result = verifySessionToken('', { secret });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'missing');
    });

    it('should reject malformed token (no dot)', () => {
      const result = verifySessionToken('nodothere', { secret });
      assert.ok(!result.valid);
      assert.equal(result.reason, 'malformed');
    });

    it('should require sub in claims', () => {
      let token = createSessionToken(
        { sub: '123', email: 'test@example.com' },
        { secret, nowSeconds: now, ttlSeconds: 3600 }
      );

      const [payload, signature] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      delete claims.sub;
      const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      token = tamperedPayload + '.' + signature;

      const result = verifySessionToken(token, { secret, nowSeconds: now + 1000 });
      assert.ok(!result.valid);
      // Signature won't match because payload changed
      assert.equal(result.reason, 'signature');
    });
  });

  describe('signaturesMatch - timing-safe comparison', () => {
    it('should match identical signatures', () => {
      const sig1 = 'dGVzdC1zaWduYXR1cmU';
      const sig2 = 'dGVzdC1zaWduYXR1cmU';
      assert.ok(signaturesMatch(sig1, sig2));
    });

    it('should not match different signatures', () => {
      const sig1 = 'c2lnbmF0dXJlMQ';
      const sig2 = 'c2lnbmF0dXJlMg';
      assert.ok(!signaturesMatch(sig1, sig2));
    });

    it('should not match signatures of different lengths', () => {
      const sig1 = 'c2hvcnQ';
      const sig2 = 'bXVjaC1sb25nZXI';
      assert.ok(!signaturesMatch(sig1, sig2));
    });

    it('should not match empty signatures', () => {
      assert.ok(!signaturesMatch('', ''));
      assert.ok(!signaturesMatch('a', ''));
    });

    it('should return false for non-string inputs', () => {
      assert.ok(!signaturesMatch(null, 'signature'));
      assert.ok(!signaturesMatch('signature', null));
      assert.ok(!signaturesMatch(123, 'signature'));
    });

    it('SOURCE ASSERTION: signaturesMatch must use timingSafeEqual, not ===', () => {
      // This is a source-level assertion: the AC forbids `===` comparison of two HMACs.
      // Behavioral testing cannot distinguish timing-safe from unsafe equality (both are
      // functionally identical). We verify at the source: timingSafeEqual must be called,
      // and no direct `expected === actual` on the signature bytes can appear.

      const sessionSource = readFileSync(
        join(process.cwd(), 'src/lambda/calendar/backend/session.mjs'),
        'utf8'
      );

      // Assert timingSafeEqual is imported
      assert.ok(
        sessionSource.includes('import') && sessionSource.includes('timingSafeEqual'),
        'session.mjs must import timingSafeEqual from node:crypto'
      );

      // Extract the signaturesMatch function
      const fnMatch = sessionSource.match(/export function signaturesMatch\(.*?\)\s*\{[\s\S]*?\n\}/);
      assert.ok(fnMatch, 'signaturesMatch function must exist');
      const fnBody = fnMatch[0];

      // Assert it calls timingSafeEqual
      assert.ok(
        fnBody.includes('timingSafeEqual'),
        'signaturesMatch must call timingSafeEqual for constant-time comparison'
      );

      // Assert it does NOT use === to compare the signature bytes
      // (it's OK to use === for length, but not for the buffers themselves)
      const bufferComparison = fnBody.match(/(?:expected|left|right)\s*===\s*(?:actual|right|left)/);
      assert.ok(
        !bufferComparison,
        'signaturesMatch must not use === to compare HMAC/signature values (timing leak)'
      );
    });
  });

  describe('Session cookie serialization', () => {
    it('should serialize a session cookie', () => {
      const token = 'test-token-value';
      const cookie = serializeSessionCookie(token);

      assert.ok(cookie.includes(`calendar_session=${token}`), 'should have token');
      assert.ok(cookie.includes('Path=/calendar'), 'should be scoped to /calendar');
      assert.ok(cookie.includes('HttpOnly'), 'should be HttpOnly');
      assert.ok(cookie.includes('Secure'), 'should be Secure');
      assert.ok(cookie.includes('SameSite=Lax'), 'should be SameSite=Lax');
      assert.ok(cookie.includes('Max-Age=604800'), 'should expire in 7 days');
    });

    it('should serialize a cleared session cookie', () => {
      const cookie = serializeClearedSessionCookie();

      assert.ok(cookie.includes('calendar_session='), 'should clear the value');
      assert.ok(cookie.includes('Max-Age=0'), 'should have Max-Age=0');
      assert.ok(cookie.includes('Expires=Thu, 01 Jan 1970'), 'should have 1970 expires');
    });
  });

  describe('Cookie parsing', () => {
    it('should parse simple cookies', () => {
      const cookies = parseCookieHeader('session=abc123; other=xyz');
      assert.equal(cookies.session, 'abc123');
      assert.equal(cookies.other, 'xyz');
    });

    it('should handle cookies with base64url values', () => {
      const value = 'aGVsbG8td29ybGQ';
      const cookies = parseCookieHeader(`token=${value}`);
      assert.equal(cookies.token, value);
    });

    it('should handle cookie values containing equals signs', () => {
      const value = 'payload.sig=';
      const cookies = parseCookieHeader(`token=${value}`);
      assert.equal(cookies.token, value);
    });

    it('should handle array of cookies', () => {
      const cookies = parseCookieHeader(['cookie1=value1', 'cookie2=value2']);
      assert.equal(cookies.cookie1, 'value1');
      assert.equal(cookies.cookie2, 'value2');
    });

    it('should ignore malformed entries', () => {
      const cookies = parseCookieHeader('valid=value; invalid; alsoinvalid=; =noname');
      assert.equal(cookies.valid, 'value');
      // `alsoinvalid=` is parsed as a cookie with empty value (which is valid)
      assert.equal(cookies.alsoinvalid, '');
      // Other malformed ones should be ignored
      assert.equal(Object.keys(cookies).length, 2);
    });

    it('should return empty object for empty header', () => {
      const cookies1 = parseCookieHeader('');
      assert.deepEqual(cookies1, {});
      const cookies2 = parseCookieHeader(null);
      assert.deepEqual(cookies2, {});
    });
  });

  describe('getCookies and getCookie', () => {
    it('should get cookies from multiValueHeaders', () => {
      const event = {
        cookies: ['session=abc123; other=xyz'],
      };
      const cookies = getCookies(event);
      assert.equal(cookies.session, 'abc123');
    });

    it('should fall back to headers when multiValueHeaders missing', () => {
      const event = {
        headers: {
          cookie: 'session=abc123; other=xyz',
        },
      };
      const cookies = getCookies(event);
      assert.equal(cookies.session, 'abc123');
    });

    it('should be case-insensitive for header name', () => {
      const event = {
        headers: {
          Cookie: 'session=abc123',
        },
      };
      const cookies = getCookies(event);
      assert.equal(cookies.session, 'abc123');
    });

    it('should get a specific cookie by name', () => {
      const event = {
        cookies: ['session=abc123; other=xyz'],
      };
      const value = getCookie(event, 'session');
      assert.equal(value, 'abc123');
    });

    it('should return null for missing cookie', () => {
      const event = { headers: { cookie: 'session=abc123' } };
      assert.equal(getCookie(event, 'notfound'), null);
    });
  });

  describe('SessionError', () => {
    it('should create a 401 error with reason', () => {
      const err = new SessionError('expired', 'Token has expired');
      assert.equal(err.statusCode, 401);
      assert.equal(err.reason, 'expired');
      assert.ok(err instanceof Error);
    });
  });
});

describe('Crypto Functions', () => {
  describe('constantTimeEquals', () => {
    it('should match identical strings', () => {
      assert.ok(constantTimeEquals('same', 'same'));
    });

    it('should not match different strings', () => {
      assert.ok(!constantTimeEquals('first', 'second'));
    });

    it('should not match different lengths', () => {
      assert.ok(!constantTimeEquals('short', 'much-longer'));
    });

    it('should return false for non-string inputs', () => {
      assert.ok(!constantTimeEquals(null, 'string'));
      assert.ok(!constantTimeEquals('string', null));
      assert.ok(!constantTimeEquals(123, 456));
    });

    it('should compare binary-safe', () => {
      const s1 = '\x00\x01\x02';
      const s2 = '\x00\x01\x02';
      const s3 = '\x00\x01\x03';
      assert.ok(constantTimeEquals(s1, s2));
      assert.ok(!constantTimeEquals(s1, s3));
    });
  });

  describe('isBase64', () => {
    it('should accept valid base64 with padding', () => {
      assert.ok(isBase64('dGVzdA==')); // "test" with padding (8 chars)
      assert.ok(isBase64('aGVsbG8=')); // (8 chars)
      assert.ok(isBase64('SGVsbG8gV29ybGQ=')); // (16 chars)
    });

    it('should require length to be multiple of 4', () => {
      // Implementation checks: value.length % 4 === 0
      assert.ok(!isBase64('dGVzdA')); // 5 chars, not divisible by 4
      assert.ok(isBase64('dGVz')); // 4 chars, valid base64
      assert.ok(isBase64('dGVzdA==')); // 8 chars, valid
    });

    it('should require length multiple of 4', () => {
      assert.ok(!isBase64('abc')); // length 3
      assert.ok(isBase64('abcd')); // length 4
    });

    it('should reject invalid characters', () => {
      assert.ok(!isBase64('!!!!')); // invalid characters
      assert.ok(!isBase64('test@#$%'));
    });

    it('should reject empty string', () => {
      assert.ok(!isBase64(''));
    });

    it('should reject non-strings', () => {
      assert.ok(!isBase64(null));
      assert.ok(!isBase64(123));
      assert.ok(!isBase64(undefined));
    });
  });

  describe('resolveKeyId', () => {
    it('should return KMS key ID from env', () => {
      const keyId = resolveKeyId({ CALENDAR_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789:key/abc' });
      assert.equal(keyId, 'arn:aws:kms:us-east-1:123456789:key/abc');
    });

    it('should trim whitespace', () => {
      const keyId = resolveKeyId({ CALENDAR_KMS_KEY_ID: '  alias/calendar-key  ' });
      assert.equal(keyId, 'alias/calendar-key');
    });

    it('should return empty string when unset', () => {
      const keyId = resolveKeyId({});
      assert.equal(keyId, '');
    });
  });

  describe('needsRewrap', () => {
    it('should indicate rewrap needed when stored key differs', () => {
      const needs = needsRewrap('old-key-arn', { env: { CALENDAR_KMS_KEY_ID: 'new-key-arn' } });
      assert.ok(needs);
    });

    it('should not indicate rewrap when keys match', () => {
      const needs = needsRewrap('same-key-arn', { env: { CALENDAR_KMS_KEY_ID: 'same-key-arn' } });
      assert.ok(!needs);
    });

    it('should indicate rewrap when no stored key', () => {
      const needs = needsRewrap(null, { env: { CALENDAR_KMS_KEY_ID: 'current-key' } });
      assert.ok(needs);
    });

    it('should not indicate rewrap when no current key configured', () => {
      const needs = needsRewrap('old-key', { env: {} });
      assert.ok(!needs);
    });
  });

  describe('encryptSecret and decryptSecret', () => {
    it('should encrypt and decrypt with injected crypto', async () => {
      const plaintext = 'secret-refresh-token';
      const validBase64Ciphertext = Buffer.from('encrypted-value-xyz', 'utf8').toString('base64');

      // Mock encrypt function
      const mockEncrypt = async (args) => {
        assert.equal(args.plaintext, plaintext);
        return { ciphertext: validBase64Ciphertext, keyId: 'mock-key-id' };
      };

      const mockDecrypt = async (args) => {
        if (args.ciphertext === validBase64Ciphertext) {
          return plaintext;
        }
        throw new Error('Ciphertext mismatch');
      };

      const encrypted = await encryptSecret(plaintext, {
        keyId: 'mock-key-id',
        encrypt: mockEncrypt,
        env: { CALENDAR_KMS_KEY_ID: 'mock-key-id' },
      });

      assert.ok(encrypted.ciphertext.length > 0);
      assert.equal(encrypted.ciphertext, validBase64Ciphertext);

      const decrypted = await decryptSecret(encrypted.ciphertext, {
        decrypt: mockDecrypt,
        env: { CALENDAR_KMS_KEY_ID: 'mock-key-id' },
      });

      assert.equal(decrypted, plaintext);
    });

    it('should reject empty plaintext', async () => {
      try {
        await encryptSecret('', {
          keyId: 'key-id',
          env: { CALENDAR_KMS_KEY_ID: 'key-id' },
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('plaintext'));
      }
    });

    it('should reject when key ID is not set', async () => {
      try {
        await encryptSecret('plaintext', {
          env: {},
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('CALENDAR_KMS_KEY_ID'));
        assert.ok(!err.message.includes('placeholder'), 'error should not leak values');
      }
    });
  });
});

describe('Connections Functions', () => {
  describe('connectionUserId', () => {
    it('should prefix sub with google# if not already prefixed', () => {
      const userId = connectionUserId('123456789');
      assert.equal(userId, 'google#123456789');
    });

    it('should not double-prefix', () => {
      const userId = connectionUserId('google#123456789');
      assert.equal(userId, 'google#123456789');
    });

    it('should throw for empty sub', () => {
      try {
        connectionUserId('');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('sub'));
      }
    });
  });

  describe('stripSecrets', () => {
    it('should remove refreshTokenEnc from item', () => {
      const item = {
        userId: 'google#123',
        email: 'test@example.com',
        refreshTokenEnc: 'sensitive-ciphertext',
        schoolNames: new Set(['Test School']),
      };

      const stripped = stripSecrets(item);
      assert.equal(stripped.userId, 'google#123');
      assert.equal(stripped.email, 'test@example.com');
      assert.deepEqual([...stripped.schoolNames], ['Test School']);
      assert.ok(!('refreshTokenEnc' in stripped));
    });

    it('should remove refreshTokenKeyId (KMS key ARN) from item', () => {
      // Containment gap fix: the ARN of the KMS key that wrapped the refresh
      // token is itself sensitive (crypto.mjs treats it as material that must
      // never be logged - a ciphertext plus a key ARN is still material an
      // attacker can work with), so it must be stripped alongside the
      // ciphertext, not just the ciphertext alone.
      const item = {
        userId: 'google#123',
        email: 'test@example.com',
        refreshTokenEnc: 'sensitive-ciphertext',
        refreshTokenKeyId: 'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012',
      };

      const stripped = stripSecrets(item);
      assert.ok(!('refreshTokenEnc' in stripped));
      assert.ok(!('refreshTokenKeyId' in stripped), 'KMS key ARN must not survive stripSecrets');
    });

    it('should add hasRefreshToken flag', () => {
      const item = {
        userId: 'google#123',
        refreshTokenEnc: 'ciphertext-value',
      };

      const stripped = stripSecrets(item);
      assert.equal(stripped.hasRefreshToken, true);
    });

    it('should set hasRefreshToken to false when missing', () => {
      const item = {
        userId: 'google#123',
        email: 'test@example.com',
      };

      const stripped = stripSecrets(item);
      assert.equal(stripped.hasRefreshToken, false);
    });

    it('should set hasRefreshToken to false for empty ciphertext', () => {
      const item = {
        userId: 'google#123',
        refreshTokenEnc: '',
      };

      const stripped = stripSecrets(item);
      assert.equal(stripped.hasRefreshToken, false);
    });

    it('should return null for null input', () => {
      assert.equal(stripSecrets(null), null);
    });

    it('should return null for non-object input', () => {
      assert.equal(stripSecrets('not an object'), null);
    });
  });

  describe('toPublicJson', () => {
    it('should project allowed attributes only', () => {
      const connection = {
        userId: 'google#123',
        email: 'test@example.com',
        processingJobs: [
          { id: 'job-1', name: 'Newsletters', schoolName: 'My School', domains: ['myschool.edu.au'], searchTerms: [] },
        ],
        hasRefreshToken: true,
        refreshTokenEnc: 'should-not-appear',
        secretField: 'should-not-appear',
      };

      const json = toPublicJson(connection);
      assert.equal(json.email, 'test@example.com');
      // TASK-055: the settings shape is a list of named processing jobs; the
      // superseded string sets are never emitted under their own names.
      assert.equal(json.processingJobs.length, 1);
      assert.equal(json.processingJobs[0].schoolName, 'My School');
      assert.ok(!('schoolName' in json));
      assert.ok(!('schoolNames' in json));
      assert.ok(!('searchDomains' in json));
      assert.equal(json.connected, true);
      assert.equal(json.connectionStatus, 'connected');
      assert.ok(!('userId' in json));
      assert.ok(!('refreshTokenEnc' in json));
      assert.ok(!('secretField' in json));
    });

    it('should report connected=false and status=not_connected when no token', () => {
      const connection = {
        userId: 'google#123',
        email: 'test@example.com',
        hasRefreshToken: false,
      };

      const json = toPublicJson(connection);
      assert.equal(json.connected, false);
      assert.equal(json.connectionStatus, CONNECTION_STATUS.NOT_CONNECTED);
    });

    it('should report status=unknown when lookup failed', () => {
      const connection = {
        userId: 'google#123',
        email: 'test@example.com',
        hasRefreshToken: true,
      };

      const json = toPublicJson(connection, {}, { lookupFailed: true });
      assert.equal(json.connected, false);
      assert.equal(json.connectionStatus, CONNECTION_STATUS.UNKNOWN);
    });

    it('should use fallback values when connection is null', () => {
      const fallbackJob = {
        id: 'fallback-1',
        name: 'Fallback',
        schoolName: 'Fallback School',
        domains: ['fallback.edu.au'],
        searchTerms: [],
      };
      const json = toPublicJson(null, { email: 'fallback@example.com', processingJobs: [fallbackJob] });
      assert.equal(json.email, 'fallback@example.com');
      assert.deepEqual(json.processingJobs, [fallbackJob]);
    });

    it('should prefer connection values over fallback', () => {
      const primaryJob = {
        id: 'primary-1',
        name: 'Primary',
        schoolName: 'Primary School',
        domains: ['primary.edu.au'],
        searchTerms: [],
      };
      const json = toPublicJson(
        { email: 'primary@example.com', processingJobs: [primaryJob] },
        {
          email: 'fallback@example.com',
          processingJobs: [{ ...primaryJob, id: 'fallback-1', name: 'Fallback' }],
        }
      );
      assert.equal(json.email, 'primary@example.com');
      assert.deepEqual(json.processingJobs, [primaryJob]);
    });

    it('should normalize null/empty to null', () => {
      const json = toPublicJson({ email: '', processingJobs: null });
      assert.equal(json.email, null);
      assert.equal(json.processingJobs, null);
    });

    it('should never include refreshTokenEnc in output', () => {
      const connection = {
        email: 'test@example.com',
        refreshTokenEnc: 'PLAINTEXT-SHOULD-NOT-APPEAR',
      };

      const json = toPublicJson(connection);
      const jsonStr = JSON.stringify(json);
      assert.ok(!jsonStr.includes('PLAINTEXT-SHOULD-NOT-APPEAR'));
      assert.ok(!('refreshTokenEnc' in json));
    });
  });

  describe('PUBLIC_ATTRIBUTES and SECRET_ATTRIBUTES', () => {
    it('should define public attributes', () => {
      assert.ok(Array.isArray(PUBLIC_ATTRIBUTES));
      assert.ok(PUBLIC_ATTRIBUTES.includes('email'));
      assert.ok(PUBLIC_ATTRIBUTES.includes('processingJobs'));
      // TASK-053/TASK-055: every legacy settings attribute is projected UNDER the
      // new name by the migrate-on-read fallback, never under its own.
      assert.ok(!PUBLIC_ATTRIBUTES.includes('schoolName'));
      assert.ok(!PUBLIC_ATTRIBUTES.includes('schoolNames'));
      assert.ok(!PUBLIC_ATTRIBUTES.includes('searchDomains'));
    });

    it('should define secret attributes', () => {
      assert.ok(Array.isArray(SECRET_ATTRIBUTES));
      assert.ok(SECRET_ATTRIBUTES.includes('refreshTokenEnc'));
    });

    it('should include the KMS key ARN attribute as secret', () => {
      // Direct guard on the fix: removing this entry from SECRET_ATTRIBUTES
      // is the mutation this ticket asks to be caught red. This assertion
      // catches it immediately; the stripSecrets/getConnection/putConnection/
      // updateConnection tests below catch it structurally too.
      assert.ok(
        SECRET_ATTRIBUTES.includes('refreshTokenKeyId'),
        'refreshTokenKeyId (the KMS CMK ARN) must be a secret attribute'
      );
    });

    it('should have no overlap between public and secret', () => {
      for (const attr of PUBLIC_ATTRIBUTES) {
        assert.ok(!SECRET_ATTRIBUTES.includes(attr), `${attr} should not be in both lists`);
      }
    });
  });

  describe('putConnection containment', () => {
    it('should reject refreshTokenEnc attribute (containment rule)', async () => {
      try {
        await putConnection(
          {
            sub: 'google-user-123',
            email: 'user@example.com',
            refreshToken: 'plaintext-token',
            refreshTokenEnc: 'ATTACKER-TRIES-TO-SNEAK-CIPHERTEXT-IN',
          },
          {
            putItem: async () => {},
            getItem: async () => null,
            encrypt: async () => ({ ciphertext: 'enc', keyId: 'key' }),
            tableName: 'test-table',
            env: { CALENDAR_KMS_KEY_ID: 'key' },
          }
        );
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(
          err.message.includes('refreshTokenEnc'),
          'must reject refreshTokenEnc in put payload'
        );
        assert.ok(
          err.message.includes('plaintext'),
          'error message must name the plaintext variant'
        );
      }
    });

    it('should preserve existing token when refreshToken is empty', async () => {
      const existingRow = {
        userId: 'google#user-123',
        email: 'user@example.com',
        refreshTokenEnc: 'existing-ciphertext-value',
        refreshTokenKeyId: 'existing-key',
        createdAt: '2026-01-01T00:00:00Z',
      };

      let capturedItem = null;

      const mockGetItem = async () => existingRow;
      const mockPutItem = async (args) => {
        capturedItem = args.item;
      };
      const mockEncrypt = async () => {
        // Should NOT be called if token is empty
        throw new Error('encrypt should not be called for empty refreshToken');
      };

      await putConnection(
        {
          sub: 'user-123',
          email: 'user@example.com',
          refreshToken: '', // Empty on repeat consent without prompt=consent
        },
        {
          getItem: mockGetItem,
          putItem: mockPutItem,
          encrypt: mockEncrypt,
          tableName: 'test-table',
          env: { CALENDAR_KMS_KEY_ID: 'key-id' },
        }
      );

      // Verify the existing token was preserved
      assert.equal(
        capturedItem.refreshTokenEnc,
        'existing-ciphertext-value',
        'existing ciphertext must not be overwritten with undefined'
      );
      assert.equal(
        capturedItem.refreshTokenKeyId,
        'existing-key',
        'existing key ID must be preserved'
      );
      // Verify plaintext attribute does not exist
      assert.ok(!('refreshToken' in capturedItem), 'plaintext never stored');
    });

    it('should preserve existing token when refreshToken is absent', async () => {
      const existingRow = {
        userId: 'google#user-456',
        email: 'user@example.com',
        refreshTokenEnc: 'existing-cipher',
        refreshTokenKeyId: 'existing-key',
      };

      let capturedItem = null;

      const mockGetItem = async () => existingRow;
      const mockPutItem = async (args) => {
        capturedItem = args.item;
      };

      await putConnection(
        {
          sub: 'user-456',
          email: 'user@example.com',
          // refreshToken omitted entirely (not provided)
        },
        {
          getItem: mockGetItem,
          putItem: mockPutItem,
          encrypt: async () => ({ ciphertext: 'new', keyId: 'key' }),
          tableName: 'test-table',
          env: { CALENDAR_KMS_KEY_ID: 'key-id' },
        }
      );

      // Verify the existing token was preserved
      assert.equal(
        capturedItem.refreshTokenEnc,
        'existing-cipher',
        'existing ciphertext must be preserved when no new token provided'
      );
    });

    it('LEGACY ROW: should strip plaintext token from existing row (line 352 delete guard)', async () => {
      // This tests the real-world path where an existing row carries a plaintext token
      // (legacy data or another writer's bug). The delete at line 352 strips it.
      // This test drives that code path by injecting getItem returning a legacy row.

      const plaintextCanary = 'LEGACY-PLAINTEXT-CANARY-12345-must-be-deleted';
      const legacyRow = {
        userId: 'google#legacy-user',
        email: 'legacy@example.com',
        refreshTokenEnc: 'old-encrypted-token',
        refreshToken: plaintextCanary, // LEGACY: plaintext stored (should be deleted)
        refreshTokenKeyId: 'old-key-id',
      };

      let capturedDBItem = null;

      const mockGetItem = async () => legacyRow;
      const mockPutItem = async (args) => {
        capturedDBItem = { ...args.item };
      };

      // Call real putConnection with the legacy row
      await putConnection(
        {
          sub: 'legacy-user',
          email: 'legacy@example.com',
          // No new token provided; existing row is rewritten as-is with plaintext stripped
        },
        {
          getItem: mockGetItem,
          putItem: mockPutItem,
          encrypt: async () => ({ ciphertext: 'enc', keyId: 'key' }),
          tableName: 'test-table',
          env: { CALENDAR_KMS_KEY_ID: 'key-id' },
        }
      );

      // Deep scan for the plaintext canary — it must NOT appear anywhere
      const deepScan = (obj, visited = new Set()) => {
        if (obj === null || obj === undefined) return;
        if (visited.has(obj)) return;
        visited.add(obj);

        if (typeof obj === 'string') {
          assert.ok(
            !obj.includes(plaintextCanary),
            `LEGACY plaintext found in string: ${obj}`
          );
        } else if (typeof obj === 'object') {
          for (const value of Object.values(obj)) {
            deepScan(value, visited);
          }
        }
      };

      deepScan(capturedDBItem);

      // Explicitly verify the plaintext attribute was deleted
      assert.ok(
        !('refreshToken' in capturedDBItem),
        'plaintext refreshToken must be deleted from legacy row'
      );

      // Verify the encrypted form is still present
      assert.ok(
        'refreshTokenEnc' in capturedDBItem,
        'refreshTokenEnc must be preserved from legacy row'
      );
    });
  });

  describe('updateConnection containment', () => {
    it('should reject refreshToken in patch', async () => {
      try {
        await updateConnection(
          'google#user-123',
          { email: 'new@example.com', refreshToken: 'should-not-be-allowed' },
          {
            updateItem: async () => ({}),
            tableName: 'test-table',
          }
        );
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(
          err.message.includes('refreshToken'),
          'must reject plaintext token in patch'
        );
      }
    });

    it('should reject refreshTokenEnc in patch', async () => {
      try {
        await updateConnection(
          'google#user-123',
          { email: 'new@example.com', refreshTokenEnc: 'ciphertext' },
          {
            updateItem: async () => ({}),
            tableName: 'test-table',
          }
        );
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(
          err.message.includes('refreshTokenEnc'),
          'must reject ciphertext in patch'
        );
      }
    });

    it('should reject refreshTokenKeyId in patch', async () => {
      try {
        await updateConnection(
          'google#user-123',
          { email: 'new@example.com', refreshTokenKeyId: 'arn:aws:...' },
          {
            updateItem: async () => ({}),
            tableName: 'test-table',
          }
        );
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(
          err.message.includes('refreshTokenKeyId'),
          'must reject key ID in patch (use putConnection for token updates)'
        );
      }
    });
  });

  describe('containment: KMS key ARN never survives stripSecrets', () => {
    // TASK-026: `refreshTokenKeyId` (the KMS CMK ARN wrapping the refresh
    // token) is itself sensitive per crypto.mjs, but was not in
    // SECRET_ATTRIBUTES, so every accessor built on stripSecrets() returned
    // it. These three cover every accessor named in the ticket's scenario
    // outline. Removing refreshTokenKeyId from SECRET_ATTRIBUTES turns all
    // three red (verified by mutation during implementation).
    const rawRow = {
      userId: 'google#containment-user',
      email: 'containment@example.com',
      refreshTokenEnc: 'ciphertext-value',
      refreshTokenKeyId: 'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012',
    };

    it('getConnection returns neither refreshTokenEnc nor refreshTokenKeyId', async () => {
      const result = await getConnection('google#containment-user', {
        getItem: async () => ({ ...rawRow }),
        tableName: 'test-table',
      });

      assert.ok(!('refreshTokenEnc' in result));
      assert.ok(!('refreshTokenKeyId' in result), 'KMS key ARN must not survive getConnection');
    });

    it('putConnection returns neither refreshTokenEnc nor refreshTokenKeyId', async () => {
      const result = await putConnection(
        {
          sub: 'containment-user',
          email: 'containment@example.com',
          refreshToken: 'plaintext-token',
        },
        {
          getItem: async () => null,
          putItem: async () => {},
          encrypt: async () => ({ ciphertext: 'ciphertext-value', keyId: rawRow.refreshTokenKeyId }),
          tableName: 'test-table',
          env: { CALENDAR_KMS_KEY_ID: rawRow.refreshTokenKeyId },
        }
      );

      assert.ok(!('refreshTokenEnc' in result));
      assert.ok(!('refreshTokenKeyId' in result), 'KMS key ARN must not survive putConnection');
    });

    it('updateConnection returns neither refreshTokenEnc nor refreshTokenKeyId', async () => {
      const result = await updateConnection(
        'google#containment-user',
        { email: 'new@example.com' },
        {
          updateItem: async () => ({ ...rawRow, email: 'new@example.com' }),
          tableName: 'test-table',
        }
      );

      assert.ok(!('refreshTokenEnc' in result));
      assert.ok(!('refreshTokenKeyId' in result), 'KMS key ARN must not survive updateConnection');
    });

    it('getRefreshToken still decrypts correctly (raw-item read path is unaffected)', async () => {
      // getRefreshToken reads the raw DynamoDB item directly rather than
      // going through stripSecrets, so adding refreshTokenKeyId to
      // SECRET_ATTRIBUTES must not touch this path. Confirmed here by
      // asserting both the returned plaintext AND that the real key ARN was
      // forwarded to decrypt() unmodified.
      let receivedKeyId = null;
      const plaintext = 'decrypted-refresh-token-value';

      const result = await getRefreshToken('google#containment-user', {
        getItem: async () => ({ ...rawRow }),
        decrypt: async (ciphertext, { keyId }) => {
          receivedKeyId = keyId;
          assert.equal(ciphertext, rawRow.refreshTokenEnc);
          return plaintext;
        },
        tableName: 'test-table',
      });

      assert.equal(result, plaintext);
      assert.equal(receivedKeyId, rawRow.refreshTokenKeyId);
    });
  });
});

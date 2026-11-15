// Focused Phase 1 tests. Provider/Auth calls are mocked; no emails or live RPCs.
// Run: node --test tests/phase1-security/edge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(
  new URL('../../supabase/functions/send-invitation/index.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length ?? 0, 0);

function fixture(overrides = {}) {
  const state = { calls: [], emails: [], ...overrides };
  const env = {
    SUPABASE_URL: 'https://auth.example.test',
    SUPABASE_ANON_KEY: 'test-public-credential',
    RESEND_API_KEY: 'test-email-credential',
    APP_URL: 'https://app.example.test',
    ...state.env,
  };
  const invitation = {
    invitation_id: '00000000-0000-0000-0000-000000000001',
    email: 'invited@example.test',
    token: 'database-authorized-token',
    role_code: 'technician',
    company_name: 'Verified Company',
    expires_at: '2099-12-01T00:00:00Z',
    ...state.invitation,
  };
  const exports = {};
  const context = {
    exports,
    module: { exports },
    Request, Response,
    Deno: {
      env: { get: (key) => env[key] },
      serve: (handler) => { state.registeredHandler = handler; },
    },
    require: (name) => {
      if (name === 'npm:@supabase/supabase-js@2') return {
        createClient(url, key, options) {
          state.client = { url, key, options };
          return {
            auth: {
              async getUser() {
                state.calls.push('getUser');
                if (state.authThrows) throw new Error('private upstream detail');
                return state.auth ?? { data: { user: { id: 'verified-user' } }, error: null };
              },
            },
            async rpc(name, args) {
              state.calls.push(name);
              state.args = args;
              return state.rpc ?? { data: [invitation], error: null };
            },
          };
        },
      };
      if (name === 'npm:resend') return {
        Resend: class {
          emails = {
            send: async (email) => {
              state.emails.push(email);
              if (state.providerThrows) throw new Error('private provider detail');
              return state.provider ?? { data: { id: 'provider-message' }, error: null };
            },
          };
        },
      };
      throw new Error(`Unexpected module: ${name}`);
    },
  };
  vm.runInNewContext(compiled.outputText, context);
  return { state, handle: exports.handleRequest };
}

function request(body = { token: 'requested-token' }, headers = {}, method = 'POST') {
  return new Request('https://edge.example.test/send-invitation', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-user-session', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

test('deployment requires gateway JWT verification', () => {
  const config = fs.readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(config, /verify_jwt\s*=\s*true/);
  assert.doesNotMatch(config, /verify_jwt\s*=\s*false/);
});

test('registered entry point is the tested handler', () => {
  const { state, handle } = fixture();
  assert.equal(state.registeredHandler, handle);
});

test('CORS preflight has no Auth/database/provider effects', async () => {
  const { state, handle } = fixture();
  assert.equal((await handle(request(null, {}, 'OPTIONS'))).status, 200);
  assert.equal(state.calls.length + state.emails.length, 0);
});

test('unsupported methods have no side effects', async () => {
  const { state, handle } = fixture();
  assert.equal((await handle(request(null, {}, 'GET'))).status, 405);
  assert.equal(state.calls.length + state.emails.length, 0);
});

for (const authorization of ['', 'Basic ignored', 'Bearer', 'Bearer a b']) {
  test(`missing or malformed authentication is rejected (${authorization.split(' ')[0] || 'empty'})`, async () => {
    const { state, handle } = fixture();
    assert.equal((await handle(request({}, { authorization }))).status, 401);
    assert.equal(state.calls.length + state.emails.length, 0);
  });
}

for (const auth of [
  { data: { user: null }, error: null },
  { data: { user: null }, error: { message: 'expired session' } },
]) {
  test('an unverified/expired/service-only identity cannot send', async () => {
    const { state, handle } = fixture({ auth });
    assert.equal((await handle(request())).status, 401);
    assert.deepEqual(state.calls, ['getUser']);
    assert.equal(state.emails.length, 0);
  });
}

test('caller session and public key are used, never a service-role client', async () => {
  const { state, handle } = fixture();
  assert.equal((await handle(request())).status, 200);
  assert.equal(state.client.key, 'test-public-credential');
  assert.equal(state.client.options.global.headers.Authorization, 'Bearer test-user-session');
  assert.equal(state.client.options.auth.persistSession, false);
  assert.equal(state.client.options.auth.autoRefreshToken, false);
  assert.doesNotMatch(source, /env\.get\(['"](?:SUPABASE_)?SERVICE_ROLE/);
});

test('authorization RPC is checked before email delivery', async () => {
  const { state, handle } = fixture();
  await handle(request({ token: '  requested-token  ' }));
  assert.deepEqual(state.calls, ['getUser', 'invitation_for_delivery']);
  assert.equal(state.args.p_token, 'requested-token');
  assert.equal(state.emails.length, 1);
});

for (const rpc of [
  { data: null, error: { message: 'private database detail' } },
  { data: [], error: null },
  { data: [{}, {}], error: null },
]) {
  test('forbidden, foreign, invalid or ambiguous invitation never sends', async () => {
    const { state, handle } = fixture({ rpc });
    const response = await handle(request());
    assert.equal(response.status, 403);
    assert.equal(state.emails.length, 0);
    assert.doesNotMatch(await response.text(), /private database detail/);
  });
}

for (const body of [null, [], {}, { token: 1 }, { token: ' ' }, { token: 'x'.repeat(257) }]) {
  test('invalid invitation payload is rejected without sending', async () => {
    const { state, handle } = fixture();
    assert.equal((await handle(request(body))).status, 400);
    assert.equal(state.emails.length, 0);
    assert.deepEqual(state.calls, ['getUser']);
  });
}

test('malformed JSON is rejected after authentication', async () => {
  const { state, handle } = fixture();
  const req = new Request('https://edge.example.test', {
    method: 'POST', headers: { authorization: 'Bearer test-user-session' }, body: '{',
  });
  assert.equal((await handle(req)).status, 400);
  assert.equal(state.emails.length, 0);
});

test('recipient, company, role, token and expiry are taken only from authorized SQL result', async () => {
  const { state, handle } = fixture();
  const response = await handle(request({
    token: 'requested-token', email: 'attacker@example.test',
    company_name: 'Forged Company', role: 'owner', expires_at: '1900-01-01',
  }));
  assert.equal(response.status, 200);
  const email = state.emails[0];
  assert.equal(email.to, 'invited@example.test');
  assert.match(email.subject, /Verified Company/);
  assert.match(email.text, /a technician/);
  assert.match(email.text, /database-authorized-token/);
  assert.match(email.text, /2099/);
  assert.doesNotMatch(JSON.stringify(email), /attacker@|Forged Company|1900-01-01|requested-token/);
});

test('stored company markup remains escaped in HTML', async () => {
  const { state, handle } = fixture({ invitation: { company_name: '<script>alert(1)</script>' } });
  await handle(request());
  assert.match(state.emails[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(state.emails[0].html, /<script>/);
});

for (const env of [
  { SUPABASE_URL: undefined }, { SUPABASE_ANON_KEY: undefined },
  { RESEND_API_KEY: undefined }, { APP_URL: undefined },
]) {
  test('missing required server configuration fails closed', async () => {
    const { state, handle } = fixture({ env });
    assert.equal((await handle(request())).status, 503);
    assert.equal(state.emails.length, 0);
  });
}

test('provider error is not exposed', async () => {
  const { handle } = fixture({ provider: { data: null, error: { message: 'private provider detail' } } });
  const response = await handle(request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private provider detail/);
});

for (const overrides of [{ authThrows: true }, { providerThrows: true }]) {
  test('upstream exception fails closed without leaking internals', async () => {
    const { handle } = fixture(overrides);
    const response = await handle(request());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private .* detail/);
  });
}

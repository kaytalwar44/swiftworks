import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

const root = new URL('../../', import.meta.url);
const testTelco = '0e5573a7-fcb5-4184-97ad-105602dddc89';
const ausstech = '45584402-8893-4028-93d6-477d7d6f2ce2';
const compiled = ts.transpileModule(
  fs.readFileSync(new URL('src/pages/JobCreate.tsx', root), 'utf8'),
  { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  } },
).outputText;

function identity(companyId = testTelco) {
  return {
    authUser: { id: 'signed-in-admin' },
    user: { id: 'signed-in-admin', company_id: companyId },
    company: { id: companyId },
    isLoading: false,
    error: null,
  };
}

// Execute the real component and its event handlers with mocked React hooks
// and Supabase. No database writes, browser session or production data needed.
function harness(context = identity(), insertError = null) {
  const state = [];
  let cursor = 0;
  const inserts = [];
  const navigations = [];
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react') return {
        useState(initial) {
          const index = cursor++;
          if (!(index in state)) state[index] = initial;
          return [state[index], (value) => { state[index] = value; }];
        },
      };
      if (name === 'react-router') return {
        useNavigate: () => (path) => navigations.push(path),
      };
      if (name === '@/features/auth/providers/auth-provider') return {
        useAuth: () => context,
      };
      if (name === '@/lib/supabase/client') return {
        supabase: {
          from(table) {
            assert.equal(table, 'jobs');
            return {
              async insert(rows) {
                inserts.push(JSON.parse(JSON.stringify(rows)));
                return { error: insertError };
              },
            };
          },
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  function render() {
    cursor = 0;
    return module.exports.default();
  }
  function elements(node = render()) {
    if (!node || typeof node !== 'object') return [];
    const children = node.props?.children;
    return [node, ...[children].flat(Infinity).flatMap((child) =>
      child && typeof child === 'object' ? elements(child) : [])];
  }
  function fill() {
    for (const node of elements()) {
      const props = node.props ?? {};
      if (props.type === 'date') props.onChange({ target: { value: '2026-12-01' } });
      if (props.placeholder === 'Job Number') props.onChange({ target: { value: 'TENANT-TEST' } });
      if (props.placeholder === 'Title') props.onChange({ target: { value: 'Scoped job' } });
    }
  }
  return {
    inserts, navigations, elements, fill,
    submit: () => elements().find((node) => node.type === 'form').props.onSubmit({
      preventDefault() {},
    }),
    button: () => elements().find((node) => node.props?.type === 'submit'),
    alert: () => elements().find((node) => node.props?.role === 'alert')?.props.children,
    setContext: (next) => { context = next; },
  };
}

for (const [name, companyId] of [['Test Telco', testTelco], ['Ausstech', ausstech]]) {
  test(`Create Job uses the signed-in ${name} profile company`, async () => {
    const page = harness(identity(companyId));
    page.fill();
    await page.submit();
    assert.equal(page.inserts.length, 1);
    assert.equal(page.inserts[0][0].company_id, companyId);
    assert.equal(page.inserts[0][0].job_number, 'TENANT-TEST');
    assert.equal(page.inserts[0][0].start_date, '2026-12-01');
    assert.deepEqual(page.navigations, ['/jobs']);
    assert.equal(page.alert(), undefined);
  });
}

for (const [name, context] of [
  ['loading profile', { ...identity(), isLoading: true }],
  ['profile error', { ...identity(), error: new Error('Profile failed') }],
  ['signed out', { ...identity(), authUser: null }],
  ['missing profile', { ...identity(), user: null }],
  ['missing profile company', { ...identity(), user: { id: 'signed-in-admin', company_id: null } }],
  ['missing company context', { ...identity(), company: null }],
  ['foreign company context', { ...identity(), company: { id: ausstech } }],
  ['stale profile from another account', {
    ...identity(), user: { id: 'previous-ultra-admin', company_id: testTelco },
  }],
  ['platform owner without a company', {
    ...identity(), user: { id: 'signed-in-admin', company_id: null, is_platform_admin: true },
    company: null,
  }],
]) {
  test(`Create Job fails closed for ${name}`, async () => {
    const page = harness(context);
    page.fill();
    assert.equal(page.button().props.disabled, true);
    await page.submit(); // Also guards programmatic submission, not just clicks.
    assert.equal(page.inserts.length, 0);
    assert.equal(page.navigations.length, 0);
    assert.match(page.alert(), /company context/i);
  });
}

test('account switch replaces the previous platform company in the payload', async () => {
  const page = harness({
    ...identity(ausstech),
    authUser: { id: 'previous-ultra-admin' },
    user: { id: 'previous-ultra-admin', company_id: ausstech, is_platform_admin: true },
  });
  page.fill();
  page.setContext(identity(testTelco));
  await page.submit();
  assert.equal(page.inserts[0][0].company_id, testTelco);
});

test('an RLS rejection is still displayed and does not navigate', async () => {
  const message = 'new row violates row-level security policy for table "jobs"';
  const page = harness(identity(), { message });
  page.fill();
  await page.submit();
  assert.equal(page.inserts[0][0].company_id, testTelco);
  assert.equal(page.alert(), message);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.button().props.disabled, false);
});

test('required date validation still blocks inserts', async () => {
  const page = harness();
  await page.submit();
  assert.equal(page.inserts.length, 0);
  assert.equal(page.alert(), 'Start date and end date are required.');
});

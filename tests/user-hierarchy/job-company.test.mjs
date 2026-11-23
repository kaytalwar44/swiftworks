import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

const root = new URL('../../', import.meta.url);
const testTelco = '0e5573a7-fcb5-4184-97ad-105602dddc89';
const ausstech = '45584402-8893-4028-93d6-477d7d6f2ce2';
const foreignPartner = '761d03bf-e6ba-46cf-8f0e-037fdeb908cd';
const telcoPartner = '16a9947c-cd92-4e7a-a5ab-ab4cd4d859a1';
const secondTelcoPartner = 'b8a31f57-18c1-48be-9b1c-f5fb960ed9b7';
const partnerRows = [
  { id: foreignPartner, company_id: ausstech, name: 'Ausstech partner' },
  { id: telcoPartner, company_id: testTelco, name: 'Test Telco partner A' },
  { id: secondTelcoPartner, company_id: testTelco, name: 'Test Telco partner B' },
];
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
function harness(context = identity(), insertError = null, partnerLoader = () => ({
  data: partnerRows, error: null,
})) {
  const state = [];
  let cursor = 0;
  let effectCursor = 0;
  const effects = [];
  let scheduled = [];
  const inserts = [];
  const partnerQueries = [];
  const navigations = [];
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react') return {
        useEffect(effect, dependencies) {
          const index = effectCursor++;
          const previous = effects[index];
          if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
            scheduled.push(() => {
              previous?.cleanup?.();
              effects[index] = { dependencies, cleanup: effect() };
            });
          }
        },
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
            if (table === 'partners') {
              const query = { table, filters: [], ordering: [] };
              partnerQueries.push(query);
              const builder = {
                select(columns) { query.columns = columns; return builder; },
                eq(column, value) { query.filters.push([column, value]); return builder; },
                is(column, value) { query.filters.push([column, value]); return builder; },
                order(column) { query.ordering.push(column); return builder; },
                then(resolve, reject) {
                  return Promise.resolve().then(() => partnerLoader(query)).then(resolve, reject);
                },
              };
              return builder;
            }
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
    effectCursor = 0;
    scheduled = [];
    const tree = module.exports.default();
    for (const run of scheduled) run();
    return tree;
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
    inserts, navigations, elements, fill, partnerQueries,
    async ready() {
      // Flush effect/query microtasks and render their resulting state.
      for (let i = 0; i < 3; i++) {
        render();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    submit: () => elements().find((node) => node.type === 'form').props.onSubmit({
      preventDefault() {},
    }),
    button: () => elements().find((node) => node.props?.type === 'submit'),
    alert: () => elements().find((node) => node.props?.role === 'alert')?.props.children,
    partnerSelect: () => elements().find((node) => node.props?.id === 'job-partner'),
    selectPartner: (id) => elements().find((node) => node.props?.id === 'job-partner')
      .props.onChange({ target: { value: id } }),
    setContext: (next) => { context = next; },
  };
}

for (const [name, companyId] of [['Test Telco', testTelco], ['Ausstech', ausstech]]) {
  test(`Create Job uses the signed-in ${name} profile company`, async () => {
    const page = harness(identity(companyId));
    page.fill();
    await page.ready();
    await page.submit();
    assert.equal(page.inserts.length, 1);
    assert.equal(page.inserts[0][0].company_id, companyId);
    assert.equal(page.inserts[0][0].partner_id, companyId === testTelco ? telcoPartner : foreignPartner);
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
  await page.ready();
  page.setContext(identity(testTelco));
  await page.ready();
  await page.submit();
  assert.equal(page.inserts[0][0].company_id, testTelco);
});

test('an RLS rejection is still displayed and does not navigate', async () => {
  const message = 'new row violates row-level security policy for table "jobs"';
  const page = harness(identity(), { message });
  page.fill();
  await page.ready();
  await page.submit();
  assert.equal(page.inserts[0][0].company_id, testTelco);
  assert.equal(page.alert(), message);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.button().props.disabled, false);
});

test('required date validation still blocks inserts', async () => {
  const page = harness();
  await page.ready();
  await page.submit();
  assert.equal(page.inserts.length, 0);
  assert.equal(page.alert(), 'Start date and end date are required.');
});

test('partner lookup is explicitly scoped to the authenticated company', async () => {
  const page = harness();
  await page.ready();
  assert.equal(page.partnerQueries.length, 1);
  assert.deepEqual(page.partnerQueries[0].filters, [
    ['company_id', testTelco], ['deleted_at', null],
  ]);
  assert.equal(page.partnerQueries[0].columns, 'id, company_id, name');
  assert.deepEqual(page.partnerQueries[0].ordering, ['name', 'id']);
});

test('only own-company partners render, even with a broader query response', async () => {
  const page = harness();
  await page.ready();
  const options = page.elements().filter((node) => node.type === 'option')
    .map((node) => node.props.value);
  assert.ok(options.includes(telcoPartner));
  assert.ok(options.includes(secondTelcoPartner));
  assert.ok(!options.includes(foreignPartner));
  assert.equal(page.partnerSelect().props.value, telcoPartner);
});

test('choosing another own-company partner changes only the selected partner', async () => {
  const page = harness();
  page.fill();
  await page.ready();
  page.selectPartner(secondTelcoPartner);
  await page.submit();
  assert.equal(page.inserts[0][0].partner_id, secondTelcoPartner);
  assert.equal(page.inserts[0][0].company_id, testTelco);
});

for (const [label, code] of [['Admin', 'admin'], ['Super Admin', 'owner']]) {
  test(`${label} submits both company and partner from Test Telco`, async () => {
    const page = harness({ ...identity(), roles: [{ code }] });
    page.fill();
    await page.ready();
    await page.submit();
    assert.equal(page.inserts.length, 1);
    assert.equal(page.inserts[0][0].company_id, testTelco);
    assert.equal(page.inserts[0][0].partner_id, telcoPartner);
  });
}

for (const [name, id] of [['foreign partner', foreignPartner], ['unknown partner', 'forged'], ['empty selection', '']]) {
  test(`submission blocks ${name}, including programmatic submission`, async () => {
    const page = harness();
    page.fill();
    await page.ready();
    page.selectPartner(id);
    assert.equal(page.button().props.disabled, true);
    await page.submit();
    assert.equal(page.inserts.length, 0);
    assert.match(page.alert(), /Select a partner belonging to your company/);
  });
}

for (const [name, data] of [['no partners', []], ['only foreign partners', [partnerRows[0]]]]) {
  test(`${name} requires creating a company partner before a job`, async () => {
    const page = harness(identity(), null, () => ({ data, error: null }));
    page.fill();
    await page.ready();
    assert.equal(page.partnerSelect().props.disabled, true);
    assert.equal(page.partnerSelect().props.value, '');
    assert.equal(page.button().props.disabled, true);
    assert.match(page.alert(), /Create a company partner before creating a job/);
    await page.submit();
    assert.equal(page.inserts.length, 0);
  });
}

for (const [name, loader] of [
  ['query error', () => ({ data: null, error: { message: 'Access denied' } })],
  ['network exception', () => { throw new Error('Network failed'); }],
]) {
  test(`partner ${name} fails closed without a fallback partner`, async () => {
    const page = harness(identity(), null, loader);
    page.fill();
    await page.ready();
    assert.equal(page.button().props.disabled, true);
    assert.match(page.alert(), /Unable to load partners for your company/);
    await page.submit();
    assert.equal(page.inserts.length, 0);
  });
}

test('pending partner load blocks insertion', async () => {
  const page = harness(identity(), null, () => new Promise(() => {}));
  page.fill();
  await page.ready();
  assert.equal(page.button().props.disabled, true);
  await page.submit();
  assert.equal(page.inserts.length, 0);
  assert.match(page.alert(), /Wait for your company partners/);
});

test('company switch immediately hides and blocks previous-company partners', async () => {
  const page = harness(identity(ausstech));
  page.fill();
  await page.ready();
  assert.equal(page.partnerSelect().props.value, foreignPartner);
  page.setContext(identity(testTelco));
  assert.equal(page.partnerSelect().props.value, '');
  assert.equal(page.button().props.disabled, true);
  await page.submit();
  assert.equal(page.inserts.length, 0);
  await page.ready();
  await page.submit();
  assert.equal(page.inserts[0][0].company_id, testTelco);
  assert.equal(page.inserts[0][0].partner_id, telcoPartner);
});

test('late response from the previous company cannot replace new partners', async () => {
  let resolveOld;
  const oldRequest = new Promise((resolve) => { resolveOld = resolve; });
  const page = harness(identity(ausstech), null, (query) =>
    query.filters[0][1] === ausstech ? oldRequest : { data: partnerRows, error: null });
  page.fill();
  await page.ready();
  page.setContext(identity(testTelco));
  await page.ready();
  resolveOld({ data: [partnerRows[0]], error: null });
  await page.ready();
  assert.equal(page.partnerSelect().props.value, telcoPartner);
  await page.submit();
  assert.equal(page.inserts[0][0].partner_id, telcoPartner);
});

test('account switch within a company reloads partner options', async () => {
  const page = harness();
  page.fill();
  await page.ready();
  page.setContext({
    ...identity(), authUser: { id: 'another-admin' },
    user: { id: 'another-admin', company_id: testTelco },
  });
  assert.equal(page.partnerSelect().props.value, '');
  assert.equal(page.button().props.disabled, true);
  await page.ready();
  assert.equal(page.partnerQueries.length, 2);
  await page.submit();
  assert.equal(page.inserts[0][0].partner_id, telcoPartner);
});

test('invalid date range still blocks insertion after selecting a partner', async () => {
  const page = harness();
  page.fill();
  await page.ready();
  const dates = page.elements().filter((node) => node.props?.type === 'date');
  dates[1].props.onChange({ target: { value: '2026-11-30' } });
  await page.submit();
  assert.equal(page.inserts.length, 0);
  assert.equal(page.alert(), 'End date cannot be before the start date.');
});

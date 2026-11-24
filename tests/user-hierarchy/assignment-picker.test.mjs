import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

// Execute the actual Jobs modal loader without rendering the operator console.
const path = new URL('../../src/pages/Jobs.tsx', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile('Jobs.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let loader;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'openAssign') loader = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(loader);
const compiled = ts.transpileModule(`export ${loader.getText(ast)}`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ candidates = [], error = null, existingId = null } = {}) {
  const state = {};
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    setAssignFor: value => { state.job = value; },
    setAssignError: value => { state.error = value; },
    setAssignTechnicianId: value => { state.selected = value; },
    setAssignLoading: value => { state.loading = value; },
    setAssignableTechs: value => { state.candidates = value; },
    supabase: {
      async rpc(name, body) { calls.push({ name, body: { ...body } }); return { data: candidates, error }; },
      from(name) {
        assert.equal(name, 'job_technicians');
        return { select(columns) {
          assert.equal(columns, 'technician_id');
          return { eq(column, id) {
            calls.push({ assignmentColumn: column, job: id });
            return { async limit(count) {
              assert.equal(count, 1);
              return { data: existingId ? [{ technician_id: existingId }] : [], error: null };
            } };
          } };
        } };
      },
    },
  });
  return { open: module.exports.openAssign, state, calls };
}

test('assignment picker uses the job company and existing technician identity', async () => {
  const candidate = { id: 'linked-technician', full_name: 'Invited Subcontractor', code: 'SUB1' };
  const page = harness({ candidates: [candidate], existingId: candidate.id });
  await page.open({ id: 'job-1', company_id: 'test-telco' });
  assert.deepEqual(page.calls[0], {
    name: 'job_assignable_technicians', body: { p_company_id: 'test-telco' },
  });
  assert.deepEqual(page.state.candidates, [candidate]);
  assert.equal(page.state.selected, candidate.id);
  assert.equal(page.state.loading, false);
});

test('assignment picker fails closed when company-scoped eligibility lookup fails', async () => {
  const page = harness({ error: { message: 'technician assignment access forbidden' } });
  await page.open({ id: 'job-1', company_id: 'other-company' });
  assert.equal(page.state.error, 'technician assignment access forbidden');
  assert.equal(page.state.selected, '');
  assert.equal(page.state.loading, false);
  assert.equal(page.calls.length, 1);
  assert.equal(page.state.candidates, undefined);
});

test('empty candidate result keeps the current empty assignment state', async () => {
  const page = harness();
  await page.open({ id: 'job-2', company_id: 'test-telco' });
  assert.deepEqual(page.state.candidates, []);
  assert.equal(page.state.selected, '');
  assert.equal(page.state.loading, false);
});

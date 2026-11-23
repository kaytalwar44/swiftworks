import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import ts from '../../node_modules/typescript/lib/typescript.js';

const root = new URL('../../', import.meta.url);
const module = { exports: {} };
const compiled = ts.transpileModule(
  fs.readFileSync(new URL('src/features/auth/hierarchy.ts', root), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
);
vm.runInNewContext(compiled.outputText, { module, exports: module.exports });
const { hierarchyRole, assignableRoles, ROLE_LABELS } = module.exports;

for (const [codes, flag, expected] of [
  [[], true, 'ultra_admin'],
  [['owner'], false, 'owner'],
  [['admin'], false, 'admin'],
  [['company_admin'], false, 'admin'],
  [['technician'], false, 'technician'],
  [['staff'], false, 'legacy'],
  [['technician', 'admin'], false, 'conflict'],
  [['owner', 'technician'], false, 'conflict'],
  [['owner', 'admin'], false, 'owner'],
]) {
  test(`classify ${codes.join('/') || 'platform'} without first-row authority`, () => {
    assert.equal(hierarchyRole({ is_platform_admin: flag }, codes.map((code) => ({ code }))), expected);
    assert.equal(hierarchyRole({ is_platform_admin: flag }, [...codes].reverse().map((code) => ({ code }))), expected);
  });
}

for (const [actor, roles] of [
  ['ultra_admin', ['owner', 'admin', 'technician']],
  ['owner', ['admin', 'technician']],
  ['admin', ['technician']],
  ['technician', []], ['legacy', []], ['conflict', []],
]) {
  test(`delegation choices for ${actor}`, () => {
    assert.equal(JSON.stringify(assignableRoles(actor)), JSON.stringify(roles));
  });
}

test('four role labels reuse stable existing codes', () => {
  assert.equal(ROLE_LABELS.ultra_admin, 'Ultra Admin');
  assert.equal(ROLE_LABELS.owner, 'Super Admin');
  assert.equal(ROLE_LABELS.admin, 'Admin');
  assert.equal(ROLE_LABELS.technician, 'Subcontractor');
});

// These checks protect business code, not a simulated booking implementation.
// Shared Auth and database policies are tested separately and still require a
// real deployed/staging booking regression before rollout.
for (const path of [
  'src/App.tsx',
  'src/pages/BookingPage.tsx',
  'src/pages/Jobs.tsx',
  'src/pages/JobCreate.tsx',
  'src/pages/Bookings.tsx',
  'src/pages/BookingCreate.tsx',
  'src/pages/TechnicianPortal.tsx',
  'src/pages/AcceptInvitation.tsx',
]) {
  if (!fs.existsSync(new URL(path, root))) continue;
  const description = path.endsWith('/JobCreate.tsx')
    ? 'job creation preserves all payload fields except company/partner selection'
    : path.endsWith('/BookingPage.tsx')
    ? 'public booking preserves loading, validation, submission and RPC logic'
    : `booking/QR/slot/allocation workflow source unchanged: ${path}`;
  test(description, () => {
    const original = execFileSync('git', [
      'show', `c28531bc53416bea200ae8608ea537c704459817:${path}`,
    ], { cwd: root });
    let actual = fs.readFileSync(new URL(path, root), 'utf8');
    if (path.endsWith('/BookingPage.tsx')) {
      // The approved mobile UI changes presentation, not booking behaviour.
      // Compare real syntax trees for every helper and both business handlers.
      // Optional company metadata is presentation-only; existing RPC calls,
      // payloads, availability filtering and validation must remain identical.
      function operations(source) {
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const result = {};
        const helpers = new Set([
          'periodLabel', 'formatTime', 'formatDate', 'todayIso',
          'isValidAuMobile', 'isValidEmail', 'submitBooking',
        ]);
        function canonical(node) {
          const children = [];
          ts.forEachChild(node, (child) => {
            if (ts.isPropertyAssignment(child) && child.name.getText(ast) === 'company_name') return;
            children.push(canonical(child));
          });
          return {
            kind: node.kind,
            ...(ts.isIdentifier(node) || ts.isLiteralExpression(node) ? { text: node.text } : {}),
            children,
          };
        }
        function visit(node) {
          if (ts.isFunctionDeclaration(node) && helpers.has(node.name?.text)) {
            result[node.name.text] = canonical(node);
          }
          if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'loadBooking') {
            result.loadBooking = canonical(node.initializer);
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
        assert.equal(Object.keys(result).length, 8);
        return result;
      }
      assert.deepEqual(operations(actual), operations(original.toString()));
      return;
    }
    if (path.endsWith('/JobCreate.tsx')) {
      // JobCreate has approved tenant/partner selection fixes. Compare every
      // other inserted field with the legacy payload instead of stripping UI.
      function payloadFields(source) {
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let payload;
        function visit(node) {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === 'insert' && ts.isArrayLiteralExpression(node.arguments[0])) {
            payload = node.arguments[0].elements[0];
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
        assert.ok(payload && ts.isObjectLiteralExpression(payload), 'job insert payload exists');
        return payload.properties
          .filter((property) => !['company_id', 'partner_id'].includes(property.name?.getText(ast)))
          .map((property) => property.getText(ast));
      }
      assert.deepEqual(payloadFields(actual), payloadFields(original.toString()));
      return;
    }
    // Approved enhancements add export presentation only, and pass the existing
    // invitation token to Auth. Removing exactly those additions must reproduce
    // the original workflow source byte-for-byte.
    if (path.endsWith('/Jobs.tsx') || path.endsWith('/Bookings.tsx')) {
      actual = actual.replace("import { ExportButton } from '@/components/shared/export-button';\n", '')
        .replace(/^          <ExportButton[\s\S]*? \/>\n/m, '');
    }
    if (path.endsWith('/AcceptInvitation.tsx')) {
      actual = actual.replace('      options: { data: { invitation_token: token } },\n', '');
    }
    assert.equal(actual, original.toString());
  });
}

test('Admin user administration no longer depends on users.manage visibility', () => {
  const sidebar = fs.readFileSync(new URL('src/components/Sidebar.tsx', root), 'utf8');
  assert.match(sidebar, /item\.to === '\/users' \? canManageUsers/);
  assert.match(sidebar, /'ultra_admin', 'owner', 'admin'/);
});

test('legacy invitation role UUID is not used by technician administration', () => {
  const source = fs.readFileSync(new URL('src/pages/Technicians.tsx', root), 'utf8');
  assert.doesNotMatch(source, /5f2749c9-b1ce-4a07-8fd4-a0b935c8ba21/);
  assert.match(source, /rpc\('hierarchy_invite'/);
  assert.match(source, /functions\.invoke\('send-invitation'/);
});

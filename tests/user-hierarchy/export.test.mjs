import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import ts from '../../node_modules/typescript/lib/typescript.js';

const root = new URL('../../', import.meta.url);
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync(new URL('src/lib/export-xlsx.ts', root), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { module, exports: module.exports, TextEncoder, Uint8Array, DataView });
const { createXlsx } = module.exports;

test('XLSX has valid ZIP CRCs, XML relationships, literal cells and Unicode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftworks-xlsx-'));
  try {
    const file = path.join(dir, 'test.xlsx');
    fs.writeFileSync(file, createXlsx(
      ['Name', 'Email', 'Company', 'Role', 'Status', 'Created Date', 'Last Login'],
      [['=HYPERLINK("evil")', 'a&b@example.test', '公司 <A>', 'Admin', 'Active', null, 'Never'],
       ['00123', '+cmd', '-cmd', '@SUM(1)', 123, false, '\u0001clean']],
    ));
    const output = execFileSync('python', ['-c', `
import sys,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert len(z.namelist())==5
 for name in z.namelist(): E.fromstring(z.read(name))
 ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 cells=sheet.findall('.//s:row',ns)
 assert len(cells)==3
 texts=[c.find('s:is/s:t',ns).text for c in cells[1]]
 assert texts[:3]==['=HYPERLINK("evil")','a&b@example.test','公司 <A>']
 assert sheet.findall('.//s:f',ns)==[]
 assert cells[2][0].attrib['t']=='inlineStr'
 assert cells[2][4].find('s:v',ns).text=='123'
 assert cells[2][5].attrib['t']=='b'
 assert cells[2][6].find('s:is/s:t',ns).text=='clean'
 rel=E.fromstring(z.read('xl/_rels/workbook.xml.rels'))[0]
 assert 'xl/'+rel.attrib['Target'] in z.namelist()
 print('valid')
`, file], { encoding: 'utf8' });
    assert.equal(output.trim(), 'valid');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('XLSX rejects silently truncated or malformed exports', () => {
  assert.throws(() => createXlsx([], []));
  assert.throws(() => createXlsx(['Name'], [['a', 'b']]));
  assert.throws(() => createXlsx(['Name'], [['a'.repeat(32768)]]));
});

test('empty worksheet remains a valid header-only workbook', () => {
  assert.ok(createXlsx(['Name'], []).byteLength > 100);
});

test('exports do not request database data or leak booking invitation tokens', () => {
  const helper = fs.readFileSync(new URL('src/lib/export-xlsx.ts', root), 'utf8');
  assert.doesNotMatch(helper, /supabase|fetch\(|XMLHttpRequest/);
  for (const file of ['Jobs', 'Bookings', 'Users']) {
    const source = fs.readFileSync(new URL(`src/pages/${file}.tsx`, root), 'utf8');
    const button = source.match(/<ExportButton[\s\S]*? \/>/)[0];
    assert.doesNotMatch(button, /token|password|booking_url|raw_user/);
  }
});

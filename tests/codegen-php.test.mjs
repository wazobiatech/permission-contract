#!/usr/bin/env node
// =============================================================================
// Codegen test: pin PHP emitter output against checked-in fixtures.
// The PHP emitter writes three files: Role.php, Permission.php,
// RolePermissions.php. Re-running against the same contract must
// produce byte-identical output. Catches emitter regressions before
// they ship.
// =============================================================================

import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('..', here);
const contract = new URL('permissions.json', repoRoot);
const fixturesDir = new URL('fixtures/', here);
const emitter = new URL('../scripts/codegen-php.mjs', here);

const tmp = mkdtempSync(join(tmpdir(), 'codegen-php-'));
try {
  spawnSync(process.execPath, [emitter.pathname, contract.pathname, tmp], {
    encoding: 'utf8',
    stdio: 'inherit',
  });

  const generated = readdirSync(tmp).sort();
  const expected = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.php.expected'))
    .map((f) => f.replace('.php.expected', '.php'))
    .sort();

  if (JSON.stringify(generated) !== JSON.stringify(expected)) {
    console.error(`FAIL: generated files ${JSON.stringify(generated)} don't match expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }

  let pass = true;
  for (const f of generated) {
    const got = readFileSync(join(tmp, f), 'utf8');
    const wantPath = new URL(`fixtures/${f}.expected`, here);
    const want = readFileSync(wantPath, 'utf8');
    if (got !== want) {
      console.error(`FAIL: ${f} does not match fixture`);
      pass = false;
    }
  }
  if (!pass) {
    process.exit(1);
  }
  console.log('OK: codegen-php output matches all fixtures');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

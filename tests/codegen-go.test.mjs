#!/usr/bin/env node
// =============================================================================
// Codegen test: pin Go emitter output against a checked-in fixture.
// Re-running the emitter against the same contract must produce byte-
// identical output. Catches emitter regressions before they ship.
// =============================================================================

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('..', here);
const contract = new URL('permissions.json', repoRoot);
const expected = new URL('fixtures/role_permissions.go.expected', here);
const emitter = new URL('../scripts/codegen-go.mjs', here);

const actual = spawnSync(process.execPath, [emitter.pathname, contract.pathname], {
  encoding: 'utf8',
}).stdout;

const want = readFileSync(expected, 'utf8');

if (actual !== want) {
  console.error('FAIL: codegen-go output does not match tests/fixtures/role_permissions.go.expected');
  console.error('Run: node scripts/codegen-go.mjs permissions.json > tests/fixtures/role_permissions.go.expected');
  process.exit(1);
}

console.log('OK: codegen-go output matches fixture');

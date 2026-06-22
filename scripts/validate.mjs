#!/usr/bin/env node
// =============================================================================
// permission-contract — Validator.
//
// Refuses to exit 0 unless ALL invariants pass. Used in CI before any
// release tag is pushed. Also safe to run locally: `node scripts/validate.mjs`.
//
// v1.3.0 invariants (see README.md for prose):
//   1. permissions.json parses.
//   2. permissions.json matches permissions.schema.json (JSON Schema draft-07).
//   3. services[] and roles[] are unique.
//   4. Closed permission union: every perm in role_permissions appears in
//      permissions[service] (looked up by `name`).
//   5. No duplicate perms within any single role.
//   6. Every role has >=1 permission.
//   7. The `:self` suffix is required on any perm with scope "self", and
//      conversely, any perm ending in `:self` MUST have scope "self".
//   8. `self` and `project` scope perms are NEVER in any role_permissions
//      (they're granted via the resolver's universal step or via
//      TenantRole bundles, respectively).
//   9. `helios:tenant:switch` has scope "self" (universal perm — granted
//      implicitly, not in any role).
//  10. `helios:tenant:transfer` is OWNER-only — present in OWNER's
//      role_permissions AND in no other role.
//  11. Every perm in `owner_only_permissions` (helper field, optional)
//      is `platform` scope AND is present in OWNER's role_permissions
//      AND is absent from every other role.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CONTRACT_PATH = resolve(ROOT, 'permissions.json');
const SCHEMA_PATH = resolve(ROOT, 'permissions.schema.json');

const VALID_SCOPES = new Set(['self', 'platform', 'project', 'platform/project']);

/**
 * Minimal JSON Schema validator. We don't want a runtime dep on ajv
 * (the contract repo ships zero npm deps). The schema is constrained
 * enough that a hand-rolled validator covers every case that matters.
 *
 * Returns { ok: true } or { ok: false, errors: string[] }.
 */
function validateSchema(value, schema, path = '$') {
  const errors = [];

  function fail(msg) {
    errors.push(`${path}: ${msg}`);
  }

  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (schema.type !== actual) {
      fail(`expected type ${schema.type}, got ${actual}`);
      return { ok: false, errors };
    }
  }

  if (schema.type === 'object') {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) fail(`missing required property "${key}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) fail(`unexpected property "${key}"`);
      }
    }
    if (schema.$ref) {
      // Resolve $ref to its definition. Only top-level $refs to #/definitions/* are used.
      const m = schema.$ref.match(/^#\/definitions\/(.+)$/);
      if (m) {
        const def = schema.__defs?.[m[1]];
        if (!def) {
          fail(`unresolved $ref: ${schema.$ref}`);
          return { ok: false, errors };
        }
        const sub = validateSchema(value, def, path);
        if (!sub.ok) errors.push(...sub.errors);
      }
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        const sub = validateSchema(value[key], { ...subSchema, __defs: schema.definitions }, `${path}.${key}`);
        if (!sub.ok) errors.push(...sub.errors);
      }
    }
  }

  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) fail(`duplicate item: ${key}`);
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => {
        const sub = validateSchema(item, { ...schema.items, __defs: schema.definitions }, `${path}[${i}]`);
        if (!sub.ok) errors.push(...sub.errors);
      });
    }
  }

  if (schema.pattern && typeof value === 'string') {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) fail(`string "${value}" does not match pattern ${schema.pattern}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    fail(`value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function loadContract() {
  try {
    return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  } catch (err) {
    return { __parseError: err.message };
  }
}

function loadSchema() {
  try {
    return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (err) {
    return { __parseError: err.message };
  }
}

/**
 * Flatten the per-service perm objects into a Map of name → scope.
 */
function buildPermScopeMap(permissions) {
  const m = new Map();
  for (const [service, perms] of Object.entries(permissions)) {
    for (const p of perms) {
      m.set(p.name, { service, scope: p.scope });
    }
  }
  return m;
}

function main() {
  const contract = loadContract();
  const schema = loadSchema();
  const failures = [];

  if (contract.__parseError) {
    failures.push(`permissions.json failed to parse: ${contract.__parseError}`);
  }
  if (schema.__parseError) {
    failures.push(`permissions.schema.json failed to parse: ${schema.__parseError}`);
  }
  if (failures.length) {
    return finish(failures);
  }

  // 1+2: schema validation
  const schemaResult = validateSchema(contract, schema);
  if (!schemaResult.ok) {
    failures.push('permissions.json does not match permissions.schema.json:');
    schemaResult.errors.forEach(e => failures.push(`  - ${e}`));
  }

  // 3: services[] and roles[] unique
  if (new Set(contract.services).size !== contract.services.length) {
    failures.push('services[] contains duplicates');
  }
  if (new Set(contract.roles).size !== contract.roles.length) {
    failures.push('roles[] contains duplicates');
  }

  // 4: closed union — every perm in role_permissions appears in permissions[service]
  const permScope = buildPermScopeMap(contract.permissions);
  for (const [role, def] of Object.entries(contract.role_permissions)) {
    for (const perm of def.permissions) {
      if (!permScope.has(perm)) {
        failures.push(`role "${role}" references unknown perm "${perm}" (not in any permissions[service] key)`);
      }
    }
  }

  // 5: no duplicate perms within a role
  for (const [role, def] of Object.entries(contract.role_permissions)) {
    if (new Set(def.permissions).size !== def.permissions.length) {
      failures.push(`role "${role}" has duplicate permissions`);
    }
  }

  // 6: every role has >=1 permission
  for (const [role, def] of Object.entries(contract.role_permissions)) {
    if (def.permissions.length === 0) {
      failures.push(`role "${role}" has zero permissions`);
    }
  }

  // 7: :self suffix ↔ scope "self" (bidirectional)
  for (const [permName, { scope }] of permScope) {
    const endsWithSelf = permName.endsWith(':self');
    if (scope === 'self' && !endsWithSelf) {
      failures.push(`perm "${permName}" has scope "self" but is missing the ":self" suffix`);
    }
    if (endsWithSelf && scope !== 'self') {
      failures.push(`perm "${permName}" ends with ":self" but scope is "${scope}" (must be "self")`);
    }
    if (!VALID_SCOPES.has(scope)) {
      failures.push(`perm "${permName}" has invalid scope "${scope}" (must be one of: ${[...VALID_SCOPES].join(', ')})`);
    }
  }

  // 8: `self` and `project` scope perms are NEVER in any role_permissions
  for (const [role, def] of Object.entries(contract.role_permissions)) {
    for (const perm of def.permissions) {
      const info = permScope.get(perm);
      if (!info) continue; // covered by invariant 4
      if (info.scope === 'self') {
        failures.push(`role "${role}" contains self-scope perm "${perm}" — self perms are universal and must not be in any role`);
      }
      if (info.scope === 'project') {
        failures.push(`role "${role}" contains project-scope perm "${perm}" — project perms are tenant-user only and must not be in any role_permissions`);
      }
    }
  }

  // 9: helios:tenant:switch:self is self scope (universal perm)
  const SWITCH = 'helios:tenant:switch:self';
  const switchInfo = permScope.get(SWITCH);
  if (!switchInfo) {
    failures.push(`required perm "${SWITCH}" is missing from permissions[service]`);
  } else if (switchInfo.scope !== 'self') {
    failures.push(`perm "${SWITCH}" must have scope "self" (universal perm), got "${switchInfo.scope}"`);
  }

  // 10: helios:tenant:transfer is OWNER-only
  const TRANSFER = 'helios:tenant:transfer';
  for (const role of contract.roles) {
    const def = contract.role_permissions[role];
    if (role === 'OWNER') {
      if (!def.permissions.includes(TRANSFER)) {
        failures.push(`role "OWNER" missing OWNER-only perm "${TRANSFER}"`);
      }
    } else {
      if (def.permissions.includes(TRANSFER)) {
        failures.push(`role "${role}" has OWNER-only perm "${TRANSFER}" (must be OWNER-only)`);
      }
    }
  }

  // 11: owner_only_permissions helper field is consistent (if present)
  if (Array.isArray(contract.owner_only_permissions)) {
    const ownerPerms = new Set(contract.role_permissions.OWNER.permissions);
    for (const role of contract.roles) {
      if (role === 'OWNER') continue;
      const def = contract.role_permissions[role];
      const otherPerms = new Set(def.permissions);
      for (const ownerOnly of contract.owner_only_permissions) {
        if (!ownerPerms.has(ownerOnly)) {
          failures.push(`owner_only_permissions lists "${ownerOnly}" but it is NOT in role "OWNER"`);
        }
        if (otherPerms.has(ownerOnly)) {
          failures.push(`owner_only_permissions lists "${ownerOnly}" but it IS in role "${role}" (must be OWNER-only)`);
        }
        const info = permScope.get(ownerOnly);
        if (info && info.scope !== 'platform') {
          failures.push(`owner_only_permissions lists "${ownerOnly}" with scope "${info.scope}" (must be platform scope)`);
        }
      }
    }
  }

  finish(failures);
}

function finish(failures) {
  if (failures.length === 0) {
    console.log('✓ permission-contract validates cleanly.');
    process.exit(0);
  }
  console.error('✗ permission-contract validation failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main();
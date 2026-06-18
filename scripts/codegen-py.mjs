#!/usr/bin/env node
// =============================================================================
// permission-contract — Python codegen.
//
// Reads permissions.json and emits src/helios_permissions/role_permissions.py
// for the wazobiatech-helios-permissions SDK. Output preserves the closed
// `Literal[...]` Permission type that v0.1.0 / v0.2.0 hardcoded — typos in
// callers still surface at mypy/pyright time (and at runtime via the
// `is_permission` type guard).
//
// Usage:
//   node scripts/codegen-py.mjs <contract.json> > src/helios_permissions/role_permissions.py
//
// The generated file starts with a DO-NOT-EDIT header. The only input
// that changes the output is permissions.json.
// =============================================================================

import { readFileSync } from 'node:fs';

const [, , contractPath] = process.argv;
if (!contractPath) {
  console.error('usage: codegen-py.mjs <contract.json>');
  process.exit(2);
}

const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const VERSION = contract.version;
const GENERATED_AT = new Date().toISOString().slice(0, 10);

const lines = [];
const w = (s = '') => lines.push(s);

w(`"""helios-permissions — Role → Permission map and helpers.`);
w();
w(`Canonical source of truth for the platform. Generated from the`);
w(`language-agnostic JSON contract at \`wazobiatech/permission-contract\``);
w(`v${VERSION} (generated ${GENERATED_AT}). Do NOT edit by hand — edit the`);
w(`contract's \`permissions.json\` and re-run codegen.`);
w();
w(`The Helios service imports this module via the published package; Helios`);
w(`does NOT redefine the map. TS / Python / Go / Laravel SDKs that read the`);
w(`same JSON contract agree on what OWNER / ADMIN / EDITOR / VIEWER means.`);
w();
w(`Permission naming convention: \`{service}:{resource}:{action}\`.`);
w();
w(`  - service  — one of: ${contract.services.join(', ')}`);
w(`  - resource — domain noun (project, users, posts, members, ...)`);
w(`  - action   — verb (view, write, delete, manage, ...)`);
w();
w(`ZIN-4714 — \`helios:tenant:transfer\` is OWNER-only by design. Ownership`);
w(`transfer is the single entry point to the OWNER role (\`assign_member\``);
w(`and \`create_invitation\` refuse \`role=OWNER\`); it cannot be delegated`);
w(`to ADMIN.`);
w(`"""`);
w();
w(`# -----------------------------------------------------------------------------`);
w(`# Permission vocabulary`);
w(`# -----------------------------------------------------------------------------`);
w();
for (const [service, perms] of Object.entries(contract.permissions)) {
  w(`${service.toUpperCase()}_PERMISSIONS: tuple[str, ...] = (`);
  for (const p of perms) {
    w(`    "${p}",`);
  }
  w(`)`);
  w();
}

w(`# The full set of valid permission strings in the system.`);
w(`# Use Literal[...] at type-check time for closed-union typo detection.`);
w(`from typing import Final, Literal  # noqa: E402`);
w();
w(`Permission = Literal[`);
for (const [service, perms] of Object.entries(contract.permissions)) {
  // Inline comments per service for readability
  w(`    # ${service.charAt(0).toUpperCase() + service.slice(1)}`);
  for (const p of perms) {
    w(`    "${p}",`);
  }
}
w(`]`);
w();
w(`# The closed set of roles. Mirrors \`RoleType\` in Helios's Prisma schema.`);
w(`ROLES: Final[tuple[str, ...]] = (${contract.roles.map(r => `"${r}"`).join(', ')})`);
w(`Role = Literal[${contract.roles.map(r => `"${r}"`).join(', ')}]`);
w();
w();
w(`# -----------------------------------------------------------------------------`);
w(`# Role → Permission map`);
w(`# -----------------------------------------------------------------------------`);
w();
w(`ROLE_PERMISSIONS: Final[dict[str, tuple[str, ...]]] = {`);
for (const [role, def] of Object.entries(contract.role_permissions)) {
  w(`    "${role}": (`);
  for (const p of def.permissions) {
    w(`        "${p}",`);
  }
  w(`    ),`);
}
w(`}`);
w();
w();
w(`def resolve_permissions(role: str) -> tuple[str, ...]:`);
w(`    """Return the read-only permission tuple for a role.`);
w();
w(`    Spread it (\`list(resolve_permissions(role))\`) if you need a mutable`);
w(`    copy.`);
w(`    """`);
w(`    return ROLE_PERMISSIONS[role]`);
w();
w();
w(`def role_has_permission(role: str, perm: str) -> bool:`);
w(`    """\`True\` if \`role\` is granted \`perm\`.`);
w();
w(`    Convenience wrapper around \`ROLE_PERMISSIONS[role]\`. Used by Helios's`);
w(`    \`PermissionResolverService\` when resolving per-tenant membership rows.`);
w(`    """`);
w(`    return perm in ROLE_PERMISSIONS[role]`);
w();
w();
w(`def is_permission(value: object) -> bool:`);
w(`    """Type guard — \`True\` if \`value\` is a known Permission string.`);
w();
w(`    Use at trust boundaries (HTTP request bodies, Kafka payloads) where`);
w(`    the perm may be an arbitrary string and we want to reject unknowns`);
w(`    rather than silently return \`False\`.`);
w(`    """`);
w(`    if not isinstance(value, str):`);
w(`        return False`);
w(`    return (`);
const serviceChecks = contract.services.map(
  s => `        value in ${s.toUpperCase()}_PERMISSIONS`,
);
w(serviceChecks.join(' or\n'));
w(`    )`);
w();
w();
w(`def is_role(value: object) -> bool:`);
w(`    """Type guard — \`True\` if \`value\` is a known Role string."""`);
w(`    return isinstance(value, str) and value in ROLES`);

console.log(lines.join('\n') + '\n');
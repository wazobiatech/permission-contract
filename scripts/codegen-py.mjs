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
// v1.3.0 codegen: perms are partitioned by `scope` into four tuples
// (SELF_PERMISSIONS, PLATFORM_PERMISSIONS, PROJECT_PERMISSIONS,
// DUAL_PERMISSIONS). The `PERM_SCOPE` dict gives O(1) scope lookup at
// runtime — used by Helios's two-track resolver to gate which path
// (platform-user vs tenant-user) is valid for a given perm.
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

// Perms are objects in v1.3.0+. Flatten and bucket by scope.
const SELF = [];
const PLATFORM = [];
const PROJECT = [];
const DUAL = [];
for (const [, perms] of Object.entries(contract.permissions)) {
  for (const p of perms) {
    if (p.scope === 'self') SELF.push(p.name);
    else if (p.scope === 'platform') PLATFORM.push(p.name);
    else if (p.scope === 'project') PROJECT.push(p.name);
    else if (p.scope === 'platform/project') DUAL.push(p.name);
  }
}

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
w(`v1.3.0 perm scopes — the resolver uses \`PERM_SCOPE[perm]\` to gate which`);
w(`path (platform-user vs tenant-user) is valid for a given perm:`);
w();
w(`  - \`self\`              — universal, granted implicitly (no role needed).`);
w(`  - \`platform\`          — granted via ROLE_PERMISSIONS (platform-user path);`);
w(`                           cannot be bundled into a TenantRole.`);
w(`  - \`project\`           — granted via TenantRole (tenant-user path);`);
w(`                           cannot appear in ROLE_PERMISSIONS.`);
w(`  - \`platform/project\`  — valid via either path (dual-scope).`);
w();
w(`ZIN-4714 — \`helios:tenant:transfer\` is OWNER-only by design. Ownership`);
w(`transfer is the single entry point to the OWNER role (\`assign_member\``);
w(`and \`create_invitation\` refuse \`role=OWNER\`); it cannot be delegated`);
w(`to ADMIN.`);
w(`"""`);
w();
w(`# -----------------------------------------------------------------------------`);
w(`# Permission vocabulary, partitioned by scope (v1.3.0+)`);
w(`# -----------------------------------------------------------------------------`);
w();

const emitTuple = (name, items) => {
  w(`${name}: Final[tuple[str, ...]] = (`);
  for (const p of items) {
    w(`    "${p}",`);
  }
  w(`)`);
  w();
};

w(`from typing import Final, Literal  # noqa: E402`);
w();
emitTuple('SELF_PERMISSIONS', SELF);
emitTuple('PLATFORM_PERMISSIONS', PLATFORM);
emitTuple('PROJECT_PERMISSIONS', PROJECT);
emitTuple('DUAL_PERMISSIONS', DUAL);

w(`# The full set of valid permission strings in the system.`);
w(`# Use Literal[...] at type-check time for closed-union typo detection.`);
const literalBlock = (name, items) => {
  // Multi-line Literal so each line is <= 100 chars (ruff's default).
  // mypy / pyright parse this identically to a single-line Literal.
  const single = `${name} = Literal[${items.map(p => `"${p}"`).join(', ')}]`;
  if (single.length <= 100) {
    w(single);
  } else {
    w(`${name} = Literal[`);
    for (const p of items) {
      w(`    "${p}",`);
    }
    w(`]`);
  }
};
literalBlock('SelfPermission', SELF);
literalBlock('PlatformPermission', PLATFORM);
literalBlock('ProjectPermission', PROJECT);
literalBlock('DualPermission', DUAL);
w(`Permission = Literal[SelfPermission | PlatformPermission | ProjectPermission | DualPermission]`);
w();
w(`# Mirrors the contract's \`scope\` enum. Four valid values.`);
w(`PermScope = Literal["self", "platform", "project", "platform/project"]`);
w();
w(`# Perm → scope lookup, populated at module load. The two-track resolver in`);
w(`# Helios checks \`PERM_SCOPE[perm]\` to decide which path (platform-user vs`);
w(`# tenant-user) is valid for the perm.`);
w(`PERM_SCOPE: Final[dict[str, PermScope]] = {`);
for (const p of SELF) w(`    "${p}": "self",`);
for (const p of PLATFORM) w(`    "${p}": "platform",`);
for (const p of PROJECT) w(`    "${p}": "project",`);
for (const p of DUAL) w(`    "${p}": "platform/project",`);
w(`}`);
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
w(`# ROLE_PERMISSIONS only contains \`platform\` and \`platform/project\` perms;`);
w(`# \`self\` perms are universal (granted by the resolver's Step 1) and`);
w(`# \`project\` perms are for tenant users via TenantRole.`);
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
w(`def is_self_scope(perm: str) -> bool:`);
w(`    """\`True\` if \`perm\` has scope \`self\` (universal — granted without`);
w(`    any role lookup). Used by the resolver's Step 1.`);
w(`    """`);
w(`    return PERM_SCOPE.get(perm) == "self"`);
w();
w();
w(`def is_platform_grantable(perm: str) -> bool:`);
w(`    """\`True\` if \`perm\` is grantable via the platform-user path (scope`);
w(`    is \`platform\` or \`platform/project\`).`);
w(`    """`);
w(`    s = PERM_SCOPE.get(perm)`);
w(`    return s == "platform" or s == "platform/project"`);
w();
w();
w(`def is_tenant_grantable(perm: str) -> bool:`);
w(`    """\`True\` if \`perm\` is grantable via the tenant-user path (scope is`);
w(`    \`project\` or \`platform/project\`, OR scope is unknown — tenant-defined`);
w(`    perms are always grantable via TenantRole).`);
w(`    """`);
w(`    if perm not in PERM_SCOPE:`);
w(`        return True  # tenant-defined perm`);
w(`    s = PERM_SCOPE[perm]`);
w(`    return s == "project" or s == "platform/project"`);
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
w(`    return value in PERM_SCOPE`);
w();
w();
w(`def is_role(value: object) -> bool:`);
w(`    """Type guard — \`True\` if \`value\` is a known Role string."""`);
w(`    return isinstance(value, str) and value in ROLES`);

console.log(lines.join('\n') + '\n');
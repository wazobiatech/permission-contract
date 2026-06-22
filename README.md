# Nexus Permission Contract

> Language-agnostic source of truth for the platform's role → permission
> map. Consumed by [`@wazobiatech/helios-permissions`](https://bitbucket.org/wazobiatech/helios-permissions)
> (TypeScript), [`wazobiatech-helios-permissions`](https://bitbucket.org/wazobiatech/helios-permissions-py)
> (Python), [`wazobiatech/helios-permissions-go`](https://bitbucket.org/wazobiatech/helios-permissions-go)
> (Go), and [`wazobia/helios-permissions`](https://bitbucket.org/wazobiatech/helios-permissions-laravel)
> (Laravel/PHP) via codegen at SDK build time.

## Status

| | |
|---|---|
| Version | **1.3.0** |
| Mirrored to | `github.com/wazobiatech/permission-contract` (public) |
| Consumers | helios-permissions (TS), helios-permissions-py (Python), helios-permissions-go (Go), helios-permissions-laravel (PHP) |
| Tickets | ZIN-4901a (v1.0.0), ZIN-4801 (v1.3.0 — 4-scope model) |

## What lives here

```
permissions.json              # The actual contract (this is the only file SDKs codegen from)
permissions.schema.json       # JSON Schema draft-07 — validated in CI before tagging
scripts/
  validate.mjs                # Closes the permission union; refuses drift
  codegen-ts.mjs              # Emits src/role-permissions.ts for the TS SDK
  codegen-py.mjs              # Emits src/helios_permissions/role_permissions.py for the Python SDK
  codegen-go.mjs              # Emits role_permissions.go for the Go SDK (also: cmd/codegen in the Go SDK repo)
  codegen-php.mjs             # Emits Role.php, Permission.php, PermScope.php, RolePermissions.php for the Laravel SDK
                              #   (also: bin/codegen in the Laravel SDK repo)
tests/
  codegen-go.test.mjs         # Pins Go emitter output against tests/fixtures/
  codegen-php.test.mjs        # Pins PHP emitter output against tests/fixtures/
  fixtures/                   # Checked-in expected output (one per emitter language)
```

## Contract shape

```jsonc
{
  "version": "1.3.0",
  "services":  ["athens", "mercury", "muse", "helios"],
  "roles":     ["OWNER", "ADMIN", "EDITOR", "VIEWER"],
  "permissions": {
    // Each perm is an object — name + scope. See "The 4-scope model" below.
    "athens": [
      { "name": "athens:project:view",    "scope": "platform" },
      { "name": "athens:project:update",  "scope": "platform" },
      { "name": "athens:project:delete",  "scope": "platform" }
    ],
    "mercury": [
      { "name": "mercury:user:read:self",  "scope": "self"     },
      { "name": "mercury:users:read",      "scope": "platform" }
    ],
    "muse": [
      { "name": "muse:blog:read",          "scope": "platform"         },
      { "name": "muse:author:read",        "scope": "platform/project" },
      { "name": "muse:posts:read",         "scope": "project"          }
    ],
    "helios": [
      { "name": "helios:tenant:switch:self", "scope": "self"     },
      { "name": "helios:tenant:transfer",    "scope": "platform" }
    ]
  },
  "role_permissions": {
    "OWNER":  { "inherits_from": null, "permissions": [/* platform + platform/project perms only */] },
    "ADMIN":  { "inherits_from": null, "permissions": [/* ... */] },
    "EDITOR": { "inherits_from": null, "permissions": [/* ... */] },
    "VIEWER": { "inherits_from": null, "permissions": [/* ... */] }
  },
  "owner_only_permissions": [/* platform-scope destructive perms that are OWNER-only */]
}
```

The contract **explicitly lists every perm for every role**. No
`inherits_from` resolution at runtime. This is intentional — the JSON is
meant to be grep-able, diff-able in PR review, and trivial to codegen.
Resolution from `inherits_from` is a v2 concern if the matrix gets too
wide.

## Naming convention

```
{service}:{resource}:{action}
```

- `service` — one of `athens`, `mercury`, `muse`, `helios` (must be a key
  in `permissions`)
- `resource` — domain noun (project, users, posts, members, …)
- `action` — verb (view, write, delete, manage, …)

Regex enforced by the schema: `^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$`.

The reserved suffix **`:self`** marks a perms that is universal — granted
implicitly to every authenticated user. The validator enforces a
bidirectional invariant: `scope === "self"` ↔ name ends with `:self`. See
[self-scope perms](#self-scope-perms) below.

## The 4-scope model (v1.3.0+)

v1.3.0 replaces the v1.0.0 `default_grant` flag with a first-class
`scope` field on every perm. The Helios service uses
`PERM_SCOPE[perm]` to gate which resolver path is valid for a given
perm in its two-track resolver.

| Scope | Path | ROLE_PERMISSIONS | TenantRole |
|---|---|---|---|
| `self`              | universal — granted implicitly to every authenticated user | ❌ | ❌ |
| `platform`          | platform-user — granted via `ROLE_PERMISSIONS[role]`        | ✅ | ❌ |
| `project`           | tenant-user — granted via `TenantRole` bundle               | ❌ | ✅ |
| `platform/project`  | dual — valid via either path                               | ✅ | ✅ |

### Why this matters

Without scopes, a tenant admin could grant themselves (or a tenant user)
permissions that should be platform-user-only — e.g. `helios:tenant:transfer`
or `athens:project:delete`. The v1.0.0 contract had no way to express
"this perm is platform-only" — the SDK had to enforce it ad hoc.

v1.3.0 makes scope first-class. The `assignPermissionToRole` mutation
in Helios refuses to attach a `platform`-scope perm to a `TenantRole`
(at the API layer, not just by convention). The `validate.mjs`
validator refuses to put `self` or `project` perms in any
`role_permissions` entry (because they're not for platform users).

### Self-scope perms

Self-scope perms are universal — the resolver grants them to every
authenticated user without consulting `ROLE_PERMISSIONS`. They are
recognizable by the `:self` suffix in the perm name. The validator
enforces the bidirectional invariant: `scope === "self"` ↔
`name.endsWith(':self')`.

Example:

```json
{ "name": "mercury:user:read:self",  "scope": "self" },
{ "name": "mercury:user:write:self", "scope": "self" },
{ "name": "helios:tenant:switch:self", "scope": "self" }
```

`helios:tenant:switch:self` (renamed from `helios:tenant:switch` in
v1.3.0) is the canonical example — a user can always switch their
active tenant without any role.

### Tenant-defined perms

A perm that is **not** in the contract vocabulary is a
*tenant-defined perm* — it is implicitly scope `project` (tenant-user
path only). The SDK's `isTenantGrantable(string)` returns `true` for
any perm not in `PERM_SCOPE` so the resolver handles the
tenant-defined case without special-casing in the caller.

## CI invariants

The `scripts/validate.mjs` runner is the gate. It refuses to tag a
release if any of these are violated:

1. **JSON Schema valid** — `permissions.json` matches `permissions.schema.json`.
2. **`services[]` and `roles[]` are unique.**
3. **Permission union is closed** — every perm in `role_permissions[*]`
   is listed under one of the `permissions[service]` keys. A role
   cannot reference an unknown perm.
4. **No duplicate perms** — same perm string never appears twice
   in any role's permission array.
5. **No empty roles** — every role has ≥1 permission.
6. **Scope is one of the four valid values** — `self`, `platform`,
   `project`, `platform/project`.
7. **`:self` suffix ↔ `scope: "self"`** — bidirectional. Any perm with
   scope `self` must end with `:self`, and any perm ending with `:self`
   must have scope `self`.
8. **No self or project perms in any role** — `self` perms are
   universal (granted by the resolver's Step 1); `project` perms are
   for tenant users via TenantRole. Neither belongs in
   `ROLE_PERMISSIONS`.
9. **`helios:tenant:switch:self` is present and has scope `self`** —
   the universal perm that lets every user switch active tenant.
10. **`helios:tenant:transfer` is OWNER-only** — present in
    `role_permissions.OWNER.permissions` and in no other role. ZIN-4714
    invariant (ownership transfer is the single entry point to OWNER).
11. **`owner_only_permissions` helper field is consistent** (if
    present) — every perm listed must be `platform` scope, present in
    OWNER's role_permissions, and absent from every other role.

## Release process

```bash
# 1. Edit permissions.json
# 2. Bump version (semver)
# 3. Run validation
node scripts/validate.mjs
# 4. Commit, push, tag
git add permissions.json
git commit -m "feat(contract): add helios:tenant:transfer"
git tag v1.3.0
git push origin main --tags
```

SDK pipelines do NOT pull main — they pin to a specific tagged version:

```
https://raw.githubusercontent.com/wazobiatech/permission-contract/v1.3.0/permissions.json
```

Same pattern as `nexus-mcp-contract`.

## Consumer codegen

All four SDKs run the same pattern in CI:

1. Fetch `permissions.json` from the pinned GitHub mirror tag.
2. Validate it (re-run `validate.mjs` defensively).
3. Run `codegen-{ts,py,go,php}.mjs` to emit the static `role-permissions`
   files that the SDKs import.
4. `tsc` / `ruff` / `pytest` / `go test` / `phpunit` on the generated file.
5. The generated file IS the source of truth in the SDK — there is no
   runtime JSON parsing.

This preserves the closed `Permission` union / enum that the SDKs
expose for compile-time typo detection. v1.3.0 codegen also emits a
`PERM_SCOPE` map (TS / Python / Go: a dict; PHP: a `public const` on
`RolePermissions`) so the resolver can do O(1) scope lookups at
runtime. Each SDK also ships `isSelfScope`, `isPlatformGrantable`,
`isTenantGrantable` helpers derived from `PERM_SCOPE`.

The Go and PHP SDKs also ship a self-hosted emitter (`cmd/codegen` in
Go, `bin/codegen` in PHP) that produces functionally equivalent output
without requiring Node in slim CI images. The Node emitter is the
source of truth; the self-hosted emitter is a convenience.

## Why a separate repo

- One canonical JSON, edited once. The TS and Python SDKs cannot drift.
- Adding a Go or Laravel SDK is a new codegen script, not a manual port.
- PR review is grep-able: `git diff permissions.json` shows the entire
  intent of the change.
- The contract is the spec — the SDKs are derivable artifacts.

## Out of scope

- **Inheritance resolution.** `inherits_from` is in the schema but
  unused at v1.0.0+. Roles are explicit.
- **Per-service prefix overrides.** A future ticket may want
  `athens_*` prefixed strings. Not now.
- **Conditional permissions** (e.g. "OWNER on tenant A but ADMIN on
  tenant B"). Handled at the `user_projects` row level by Helios, not
  in the contract.
- **Wildcards / regex matchers.** Every perm is enumerated. (See
  HANDOFFs: "No wildcards in JWT.")
- **Multi-scope perms beyond the 4-value enum.** If a future ticket
  needs a 5th scope, the schema's enum is the single edit point.
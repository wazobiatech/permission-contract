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
| Version | **1.0.0** |
| Mirrored to | `github.com/wazobiatech/permission-contract` (public, tagged `v1.0.0`) |
| Consumers | helios-permissions (TS), helios-permissions-py (Python), helios-permissions-go (Go), helios-permissions-laravel (PHP) |
| Ticket | ZIN-4901a |

## What lives here

```
permissions.json              # The actual contract (this is the only file SDKs codegen from)
permissions.schema.json       # JSON Schema draft-07 — validated in CI before tagging
scripts/
  validate.mjs                # Closes the permission union; refuses drift
  codegen-ts.mjs              # Emits src/role-permissions.ts for the TS SDK
  codegen-py.mjs              # Emits src/helios_permissions/role_permissions.py for the Python SDK
  codegen-go.mjs              # Emits role_permissions.go for the Go SDK (also: cmd/codegen in the Go SDK repo)
  codegen-php.mjs             # Emits Role.php, Permission.php, RolePermissions.php for the Laravel SDK (also: bin/codegen in the Laravel SDK repo)
ci/
  validate.yml                # GitHub Actions — runs on every push + PR
```

## Contract shape

```jsonc
{
  "version": "1.0.0",
  "services":  ["athens", "mercury", "muse", "helios"],
  "roles":     ["OWNER", "ADMIN", "EDITOR", "VIEWER"],
  "permissions": {
    "athens":  ["athens:project:view", ...],
    "mercury": ["mercury:users:read", ...],
    "muse":    ["muse:posts:read", ...],
    "helios":  ["helios:members:view", ...]
  },
  "role_permissions": {
    "OWNER":  { "inherits_from": null, "permissions": [...] },
    "ADMIN":  { "inherits_from": null, "permissions": [...] },
    "EDITOR":  { "inherits_from": null, "permissions": [...] },
    "VIEWER": { "inherits_from": null, "permissions": [...] }
  }
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

## CI invariants

The `scripts/validate.mjs` runner is the gate. It refuses to tag a
release if any of these are violated:

1. **JSON Schema valid** — `permissions.json` matches `permissions.schema.json`.
2. **Permission union is closed** — every perm in `role_permissions[*]`
   is listed under one of the `permissions[service]` keys. A role
   cannot reference an unknown perm.
3. **No duplicate perms** — same perm string never appears twice
   in any role's permission array.
4. **`helios:tenant:switch` is universal** — present in every role's
   permission array (it's a navigation gesture, not a privileged op).
5. **`helios:tenant:transfer` is OWNER-only** — present only in
   `role_permissions.OWNER.permissions`. Reinforces the ZIN-4714
   single-entry-point-to-OWNER invariant.
6. **No empty roles** — every role has ≥1 permission.

## Release process

```bash
# 1. Edit permissions.json
# 2. Bump version (semver)
# 3. Run validation
node scripts/validate.mjs
# 4. Commit, push, tag
git add permissions.json
git commit -m "feat(contract): add helios:tenant:transfer"
git tag v1.0.0
git push origin main --tags
```

SDK pipelines do NOT pull main — they pin to a specific tagged version:

```
https://raw.githubusercontent.com/wazobiatech/permission-contract/v1.0.0/permissions.json
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
expose for compile-time typo detection.

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
  unused at v1.0.0. Roles are explicit.
- **Per-service prefix overrides.** A future ticket may want
  `athens_*` prefixed strings. Not now.
- **Conditional permissions** (e.g. "OWNER on tenant A but ADMIN on
  tenant B"). Handled at the `user_projects` row level by Helios, not
  in the contract.
- **Wildcards / regex matchers.** Every perm is enumerated. (See
  HANDOFFs: "No wildcards in JWT.")
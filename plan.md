# Atomic Enterprise Readiness Plan

> Goal: make Atomic safe enough for highly sensitive enterprise records without bloating it, without abandoning the single-kernel model, and without adding infrastructure-first complexity.

Atomic should stay what it is: one record shape, one kernel, generated API/UI, schema as atoms, permissions as atoms, tests as atoms, and zero required dependencies. The enterprise plan is not to turn Atomic into a pile of services. The plan is to harden the existing kernel with a stricter production mode, sensitive-field governance, immutable evidence, and operational safety rails.

This file compares the current project state to the minimum readiness plan and defines the work in order.

---

## Current state

Atomic already has the right substrate.

It currently includes:

- Single-file kernel in `atomic.mjs`.
- Zero required dependencies.
- Optional Postgres support through `pg` only when `ATOMIC_DB` is set.
- In-memory, SQLite, and Postgres store drivers behind one store seam.
- Tenant scoping through `lifecycle.parent`.
- Token atoms with hashed API secrets shown once on creation.
- Session atoms.
- Grant and role atoms.
- Per-field read/write checks.
- Per-field redaction.
- Role attenuation so tokens/hooks cannot exceed the issuer's grants.
- Generated HTTP API.
- Generated HTML UI.
- Inline editable grid with optimistic concurrency.
- CSV import/export.
- Transactions.
- Referential integrity with `restrict`, `cascade`, and `null` behavior.
- Hook atoms that run vetted scripts by safe basename.
- Migration atoms.
- Retention policies through policy/condition atoms.
- Log atoms for changes.
- AES-256-GCM encryption at rest when `ATOMIC_KEY` is set.
- Structural audit and self-test commands.
- 148 black-box HTTP assertions.

This means Atomic is not missing a foundation. It is missing a locked enterprise posture.

The gap is not architecture. The gap is governance.

---

## Non-goals

Do not solve enterprise readiness by adding bloat.

Do not add:

- A separate policy engine.
- A separate workflow service.
- A separate audit service.
- GraphQL.
- An ORM.
- Kafka.
- Microservices.
- A generated-code layer.
- A second admin application.
- Required dependencies.

The rule remains:

> Governance is atoms too.

---

## The readiness target

Atomic is ready for sensitive enterprise use when it can answer these questions with kernel evidence:

1. Who can see each sensitive field?
2. Who actually viewed each sensitive field?
3. Why did they view it?
4. Who changed the schema, grants, hooks, exports, or retention policy?
5. Who approved that change?
6. Can a tenant admin accidentally expose restricted data?
7. Can a CSV export leak restricted data silently?
8. Can a hook or migration bypass normal permissions?
9. Can logs be edited or deleted?
10. Can retired, expired, or legally held records be mishandled?

The answer must come from Atomic itself, not only from Azure, Postgres, or infrastructure logs.

---

## Phase 1 — Locked mode

Add a runtime mode:

```bash
ATOMIC_MODE=dev|prod|locked
```

Default should be `dev` unless explicitly configured.

### `dev`

Friendly local behavior remains allowed:

- In-memory store allowed.
- Plaintext store allowed.
- Magic-link fallback can return links in the response.
- Open-login bases allowed.
- Inline model/grant editing allowed if the actor has grants.
- Wildcard grants allowed.
- Hooks and migrations can run from safe basenames.

### `prod`

Production-safe default:

- Durable store required: `ATOMIC_STORE` or `ATOMIC_DB`.
- `ATOMIC_ADMIN_SECRET` or real mail delivery required.
- No dev magic-link response fallback.
- No in-memory store.
- Security headers and strict CSP remain mandatory.
- Logs remain append-only through API behavior.

### `locked`

Sensitive enterprise mode:

- Durable store required.
- `ATOMIC_KEY` required.
- No open-login tokens.
- No public one-click base sharing for full tenant access.
- No direct edits to dangerous governance atoms except through approved change requests.
- No wildcard `**` grants except root break-glass.
- No hooks unless the hook script is explicitly allowlisted.
- No custom migrations unless explicitly allowlisted.
- No sensitive CSV export without explicit export grant and audit event.
- No sensitive read without purpose.

Implementation should be tiny:

```js
const MODE = process.env.ATOMIC_MODE || 'dev';
const LOCKED = MODE === 'locked';
const PROD = MODE === 'prod' || LOCKED;
```

Then put guardrails in the existing write/read/export/hook paths rather than adding new paths.

---

## Phase 2 — Field classification

Extend model fields with sensitivity metadata.

Example:

```json
{
  "fields": {
    "name": { "kind": "text", "sensitivity": "internal" },
    "email": { "kind": "email", "sensitivity": "confidential" },
    "governmentIdLast4": { "kind": "text", "sensitivity": "restricted", "encrypted": true, "index": "blind" },
    "eligibilityStatus": { "kind": "enum", "values": ["eligible", "ineligible", "unknown"], "sensitivity": "restricted" }
  }
}
```

Supported sensitivity levels:

```text
public
internal
confidential
restricted
```

Minimal behavior:

- Missing sensitivity defaults to `internal`.
- `restricted` fields require explicit field grant.
- `restricted` fields require purpose-bound access in locked mode.
- `restricted` fields are excluded from CSV export unless export is explicitly granted.
- `restricted` fields always produce read audit events when revealed.
- `restricted` fields are redacted in HTML tables by default unless the actor has reveal permission.

Do not create a separate classification engine. Sensitivity belongs on model field definitions.

---

## Phase 3 — Purpose-bound sensitive reads

Add a native `purpose` atom.

Example:

```json
{
  "id": "purpose-eligibility-admin",
  "model": "atom://purpose",
  "manifest": "Eligibility administration",
  "attr": {
    "label": "Eligibility administration",
    "description": "Used for eligibility, compliance, or authorized administrative review."
  }
}
```

Extend grants with optional purpose:

```json
{
  "path": "person.governmentIdLast4",
  "mode": "read",
  "purpose": "atom://purpose-eligibility-admin"
}
```

In locked mode:

- Reading a restricted field requires a matching read grant.
- The request must carry purpose.
- Purpose may be supplied by header or query param.

Recommended minimal surface:

```http
X-Atomic-Purpose: purpose-eligibility-admin
X-Atomic-Reason: eligibility review
```

or:

```http
GET /person-123?purpose=purpose-eligibility-admin&reason=eligibility-review
```

The kernel should normalize this into request context.

Every revealed restricted field logs a `sensitive-read` atom.

---

## Phase 4 — Sensitive read evidence

Current log atoms record writes. Add read evidence only for restricted fields.

Do not log every read of every field. That would bloat the system.

Add a `sensitive-read` model:

```json
{
  "id": "sensitive-read",
  "model": "atom://model",
  "manifest": "Sensitive read evidence",
  "attr": {
    "label": "Sensitive Read",
    "version": 1,
    "fields": {
      "atom": { "kind": "text", "required": true, "filterable": true },
      "model": { "kind": "text", "required": true, "filterable": true },
      "field": { "kind": "text", "required": true, "filterable": true },
      "actor": { "kind": "ref", "to": "atom://token", "required": true },
      "session": { "kind": "ref", "to": "atom://session" },
      "purpose": { "kind": "ref", "to": "atom://purpose", "required": true },
      "reason": { "kind": "text" },
      "at": { "kind": "datetime", "required": true, "filterable": true, "sortable": true }
    }
  }
}
```

Implementation rule:

- Redaction remains the default.
- When projection reveals a restricted field, append a `sensitive-read` atom.
- Do this in the projection/redaction path, not in every route.

This makes the audit question answerable:

> Who viewed this record's restricted data, when, and why?

---

## Phase 5 — Hash-chained evidence

Current log atoms are ordinary atoms. They record changes, but they should become tamper-evident.

Add hash chaining to evidence records:

```json
{
  "prev": "sha256...",
  "hash": "sha256(prev + canonical_event)"
}
```

Apply to:

- `log`
- `sensitive-read`
- `export-job`
- `change-request`
- `approval`
- `break-glass`

Minimal implementation:

- Add a global `evidenceSeq` or continue using `logSeq` style sequencing.
- Keep `lastEvidenceHash` in memory and reconstruct on boot by sorted evidence order.
- Each evidence atom stores `prev` and `hash`.
- `--audit` verifies the chain.

No dependency is needed. Use existing `node:crypto` hashing.

---

## Phase 6 — Change requests for dangerous atoms

In locked mode, dangerous atoms cannot be directly edited even by normal admins.

Dangerous models:

```text
model
grant
role
token
hook
migration
policy
condition
retention-policy
legal-hold
purpose
export-job
break-glass
```

Add:

```text
change-request
approval
```

A `change-request` contains:

```json
{
  "target": "atom://person",
  "op": "update",
  "before": { },
  "after": { },
  "diff": [ ],
  "status": "draft|submitted|approved|rejected|applied",
  "reason": "..."
}
```

An `approval` contains:

```json
{
  "change": "atom://cr-123",
  "approver": "atom://tok-security-admin",
  "decision": "approved|rejected",
  "reason": "...",
  "at": "..."
}
```

Rules:

- Maker cannot approve their own change.
- Change request must show a diff.
- Applying the change runs through the normal existing write path.
- Applied change produces log/evidence.
- Rejected changes are retained.

This keeps schema/governance changes inside Atomic without adding a workflow service.

---

## Phase 7 — Export control

CSV is a major leakage path.

Current state has model/query CSV export. Keep it, but gate it in locked mode.

Add `export` mode to grants:

```json
{
  "path": "person.email",
  "mode": "export",
  "purpose": "atom://purpose-eligibility-admin"
}
```

Behavior:

- `read` does not imply `export`.
- `write` does not imply `export`.
- `all` implies export only outside locked mode.
- In locked mode, export requires explicit `export` grant.
- Any export containing confidential/restricted fields creates an `export-job` atom.
- Export-job records actor, model/query, fields, filters, count, purpose, reason, and timestamp.
- Restricted exports can require change-request approval later, but start with explicit grant + audit.

Add model-level option:

```json
{
  "exports": "disabled|grant|approval"
}
```

Default in locked mode:

```text
grant
```

---

## Phase 8 — Break-glass access

Wildcard root access is sometimes necessary, but it must be noisy and temporary.

Add `break-glass` atom:

```json
{
  "actor": "atom://tok-admin",
  "reason": "incident response",
  "expiresAt": "2026-06-01T00:00:00Z",
  "grants": [
    { "path": "**", "mode": "all" }
  ],
  "status": "active|expired|revoked"
}
```

Locked-mode rules:

- `**` grants are rejected unless associated with active break-glass.
- Break-glass requires reason and expiration.
- Break-glass activation creates evidence.
- Every sensitive read under break-glass is logged as sensitive-read with reason.
- Expired break-glass grants stop working automatically.

Implementation should reuse the existing grant system by expanding effective grants only when an active break-glass atom exists for the actor.

---

## Phase 9 — Legal hold and retention hardening

Current expiration is lazy and non-destructive. That is good.

Add explicit legal hold behavior.

Models:

```text
legal-hold
retention-policy
```

A `legal-hold` atom:

```json
{
  "target": "atom://person-123",
  "scope": "atom|tenant|model|query",
  "reason": "hold",
  "status": "active|released",
  "createdAt": "...",
  "releasedAt": null
}
```

Rules:

- Retire/delete is blocked for held atoms.
- Purge/export/delete operations must check active holds.
- Expiration can hide held atoms from normal reads, but cannot destroy them.
- `--audit` reports expired-but-held counts.

Do not implement physical purging first. Keep soft-delete and legal hold correct before adding hard deletion.

---

## Phase 10 — Hook and migration allowlists

Current hook and custom migration execution already restricts `run` to safe basenames. In locked mode, add an explicit allowlist.

Environment:

```bash
ATOMIC_HOOKS=census-district,normalize-email
ATOMIC_MIGRATIONS=person-v2-normalize
```

Rules:

- If locked and hook run is not allowlisted, skip and log evidence.
- If locked and custom migration run is not allowlisted, fail closed.
- Hook/migration atoms are dangerous atoms and require change request.
- Hook patch/upsert continues to run under hook grants.

This keeps the dynamic script feature but makes it production-governed.

---

## Phase 11 — Locked-mode self-tests

The existing test structure is one of Atomic's best features. Add locked-mode tests before declaring readiness.

Required tests:

1. In-memory store rejected in locked mode.
2. Missing `ATOMIC_KEY` rejected in locked mode.
3. Open-login token rejected in locked mode.
4. Direct model edit rejected in locked mode.
5. Direct grant edit rejected in locked mode.
6. Wildcard `**` grant rejected without break-glass.
7. Restricted field hidden without explicit grant.
8. Restricted field hidden without purpose.
9. Restricted field visible with grant + purpose.
10. Sensitive read creates `sensitive-read` evidence.
11. CSV export rejected without export grant.
12. CSV export with restricted field creates `export-job` evidence.
13. Maker cannot approve own change request.
14. Approved change request applies through normal write path.
15. Legal hold blocks retire/delete.
16. Hook not in allowlist does not run in locked mode.
17. Custom migration not in allowlist fails closed in locked mode.
18. Evidence hash chain verifies in `--audit`.
19. Log/evidence atoms cannot be edited through normal APIs.
20. Break-glass requires reason and expiration.

Add these to both the black-box HTTP suite and the atom self-test suite where possible.

---

## Minimal new atom types

Add only these native models:

```text
purpose
sensitive-read
change-request
approval
legal-hold
retention-policy
export-job
break-glass
```

Possibly add `classification` only if sensitivity needs reusable descriptions. Prefer field-level metadata first.

---

## Implementation order

Build in this order:

1. `ATOMIC_MODE` and locked-mode boot checks.
2. Dangerous-model write guard.
3. Field `sensitivity` metadata and restricted redaction behavior.
4. Purpose parsing from request headers/query.
5. Purpose-bound restricted reads.
6. `sensitive-read` evidence atoms.
7. Explicit `export` grant mode and CSV export audit.
8. Hook/migration allowlists.
9. Change-request and approval atoms.
10. Break-glass atoms.
11. Legal hold checks.
12. Evidence hash chain.
13. Locked-mode `--audit` checks.
14. Locked-mode test suite.

This order gives value quickly and avoids rewriting the kernel.

---

## Readiness definition

Atomic can be considered minimally ready for sensitive enterprise pilot use when all of this is true:

- `ATOMIC_MODE=locked` exists.
- Locked mode refuses unsafe boot configurations.
- Restricted fields exist and redact by default.
- Restricted reads require purpose.
- Restricted reads produce evidence.
- CSV export is separately permissioned.
- Dangerous atoms require approved change requests.
- Hooks and custom migrations are allowlisted.
- Legal holds block deletion.
- Break-glass is temporary, reasoned, and logged.
- Evidence chain verifies in `npm run audit`.
- Locked-mode tests pass.

Until then, Atomic should not be the direct system of record for high-sensitivity enterprise records. It can safely continue as the kernel prototype, control-plane model, admin UI generator, and testbed for the eventual governed system.

---

## Design mantra

Keep the system small by making the kernel stricter, not larger.

```text
same atom shape
same HTTP surface
same generated UI
same store seam
same permission system
same test philosophy

+ locked mode
+ field sensitivity
+ purpose-bound access
+ sensitive-read evidence
+ explicit export grants
+ approved governance changes
+ legal hold
+ break-glass
+ evidence hash chain
```

Atomic does not need more stack.

Atomic needs fewer escape hatches.

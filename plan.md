# Atomic Enterprise Readiness Plan

> Goal: make Atomic safe enough to be the system of record for highly sensitive
> enterprise data — without abandoning the single-kernel model, and without turning
> Atomic into a pile of services.

Atomic stays what it is: one record shape, one kernel, generated API/UI, schema as atoms,
permissions as atoms, tests as atoms, zero required dependencies. The enterprise work is to
**harden the existing kernel** with a stricter production mode, sensitive-field governance,
tamper-evident records, and operational safety rails — all as atoms.

This file states the threat model, ranks the work by leak-size-to-code, and fixes three
things an earlier draft of this plan got wrong: it left the bulk-export path ungoverned,
it specified an evidence hash chain that breaks under Postgres's advertised multi-writer
mode, and it turned every sensitive read into an unbounded write. Those are corrected here.

---

## Honest framing

This makes the kernel **stricter and larger**. It adds no services, no second app, no new
stack — that discipline holds. But it adds ~8 native models, a runtime mode, a second write
path (change requests), purpose context threaded through reads, per-tenant evidence chaining,
and export gating. That is real branching threaded through the existing read/write/export/hook
paths. The win is that it is all *coherent* growth — same atom shape, same store seam, same
test philosophy — not that it is free. Plan for the kernel to grow meaningfully past its
current ~2,900 lines.

---

## Current state

Atomic already has the right substrate. It currently includes:

- Single-file kernel in `atomic.mjs`, zero required dependencies.
- In-memory, SQLite, and Postgres store drivers behind one store seam (`pg` optional, loaded
  only when `ATOMIC_DB` is set).
- Tenant scoping through `lifecycle.parent`; per-field read/write checks and redaction.
- Token atoms with hashed API secrets shown once; session atoms; grant and role atoms.
- Role attenuation so tokens/hooks cannot exceed the issuer's grants.
- Generated HTTP API + HTML UI; inline editable grid with optimistic concurrency.
- CSV import/export; transactions; referential integrity (`restrict`/`cascade`/`null`).
- Hook atoms running vetted scripts by safe basename; migration atoms; retention via
  policy/condition atoms; `log` atoms for changes.
- AES-256-GCM encryption at rest when `ATOMIC_KEY` is set.
- Structural audit, atom self-tests, and 179 black-box HTTP assertions.

The gap is not architecture. The gap is governance posture — and a few concrete leaks below.

---

## Threat model (state it first, or you miss the leaks)

We are defending sensitive records against:

1. **Over-broad grants** — an admin or token with more reach than the task needs.
2. **Malicious or compromised insider with an app identity** — a valid token used wrongly.
3. **Malicious or compromised operator with shell/DB access** — the person who can run the
   CLI or read the database directly.
4. **Silent exfiltration** — data leaving through a path that produces no evidence (CSV, bulk
   export, a hook).
5. **Evidence tampering** — someone editing or deleting the record of what happened.

We are **not** primarily defending against disk/backup theft — `ATOMIC_KEY` already covers
that, and it does little against threats 1–3. Encryption is hygiene here, not the centerpiece.

A control only counts if the answer to "who did this, when, and why" comes from **Atomic's own
evidence**, not from Postgres or infrastructure logs.

---

## Readiness target

Atomic is ready for sensitive enterprise use when it can answer, with kernel evidence:

1. Who *can* see each sensitive field, and who *actually* viewed it, and why?
2. Who changed the schema, grants, hooks, exports, or retention — and who approved it?
3. Can a tenant admin accidentally expose restricted data?
4. Can **any** export path — CSV *or* CLI bulk dump — leak restricted data silently?
5. Can a hook or migration bypass normal permissions?
6. Can logs or evidence be edited or deleted?
7. Can retired, expired, or legally held records be mishandled?
8. Can an operator with shell access exfiltrate everything without leaving a trace?

Question 8 is the one the earlier draft missed. It drives the ordering below.

---

## Non-goals

Do not solve readiness by adding bloat. Do **not** add: a separate policy engine, a workflow
service, an audit service, GraphQL, an ORM, Kafka, microservices, a generated-code layer, a
second admin app, or any required dependency.

> Governance is atoms too.

---

## Out of scope (front it, don't pretend it's covered)

These are real enterprise requirements that this plan deliberately does **not** solve in the
kernel. Name them so procurement and ops know where they live:

- **SSO / MFA (SAML, OIDC).** Atomic authenticates by magic-link and bearer token. Federated
  SSO and MFA are an enterprise procurement gate. The intended answer is an **auth proxy in
  front** (the deployment terminates SSO and presents a kernel token), not OIDC inside the
  kernel. If that answer is unacceptable to a buyer, it becomes a future phase — but it is not
  in this plan.
- **Key management & rotation.** `ATOMIC_KEY` is a single env var. KMS integration, key
  rotation, and re-encryption are out of scope. **Note the live trade-off:** under a key,
  indexed values are blind-hashed (equality only — no range or sort). So requiring `ATOMIC_KEY`
  in locked mode silently removes range/sort on any encrypted indexed field. Classify with that
  in mind.
- **Network controls** — rate limiting, DoS, brute-force throttling on auth — belong at the
  proxy/infra layer, not the kernel.

---

## Phase 0 — `ATOMIC_MODE` and locked boot checks

> **Status: implemented (2026-05-31).** `MODE`/`LOCKED`/`PROD` constants + `assertBootMode()`
> ship in `atomic.mjs`. Boot fails closed when `prod`/`locked` lack a durable store, a real
> auth path (admin secret or mail), or — in `locked` — `ATOMIC_KEY`; an unknown mode is
> rejected. The dev magic-link fallback is suppressed in `prod`/`locked`. The *runtime* locked
> rules that don't belong to "boot" (open-login rejection, `**`-grant rejection) arrive with
> their phases — and creating an open-login token or a base already falls under the Phase 1
> dangerous-write guard, so neither can be minted in locked mode today. CSP/security headers
> are already always-on.

```bash
ATOMIC_MODE=dev|prod|locked     # default: dev
```

```js
const MODE   = process.env.ATOMIC_MODE || 'dev';
const LOCKED = MODE === 'locked';
const PROD   = MODE === 'prod' || LOCKED;
```

- **`dev`** — friendly local behavior: in-memory and plaintext stores allowed, magic-link
  returned in the response, open-login bases, wildcard grants, hooks/migrations from safe
  basenames.
- **`prod`** — durable store required (`ATOMIC_STORE` or `ATOMIC_DB`); `ATOMIC_ADMIN_SECRET`
  or real mail required; no dev magic-link fallback; no in-memory store; strict CSP/security
  headers mandatory.
- **`locked`** — everything in `prod`, plus: `ATOMIC_KEY` required; no open-login tokens; no
  public one-click full-tenant base sharing; no direct edits to dangerous governance atoms
  except through approved change requests; no wildcard `**` grant except active root
  break-glass; hooks and custom migrations must be allowlisted; **no bulk or CSV export of
  restricted data without an explicit export grant and an evidence record**; no restricted
  read without purpose.

Put guardrails in the **existing** read/write/export/hook paths. Add no new routes.

---

## Phase 1 — Close the bulk-export hole + dangerous-write guard

> Highest leak, smallest code. This lands first.

> **Status: implemented (2026-05-31).** Both halves ship behind `locked` mode (no change to
> `dev`/`prod`). The dangerous-write guard rejects direct `create`/`update`/`replace`/`delete`
> (REST *and* `/tx`) of the governance models at the one shared chokepoint. Bulk export now
> writes an `export-job` evidence atom **before** the first byte and streams **AES-GCM-sealed**
> bytes (`serializeLine`) instead of plaintext. `--import-all` refuses evidence atoms and
> re-validates every other atom against its model, failing closed before any write. Covered by
> 19 new locked-mode assertions in `test.mjs`. **Scoped to what is buildable before later
> phases:** with break-glass not yet built (Phase 8), `locked` allows only the *sealed* export
> path — the *plaintext* louder export, and gating the commands themselves behind active
> break-glass, land in Phase 8. Evidence-chain re-chaining on import is Phase 11; until then
> locked import refuses evidence outright rather than re-chaining it. The `export-job` evidence
> atom is written to the same store, so it is **not yet tamper-proof** — that is Phase 10.

**The hole.** `--export-all` and `--export-base` read straight from the store and dump every
atom verbatim — no actor, no grants, no redaction, no purpose, no evidence (`atomic.mjs`
≈2861–2882). If `ATOMIC_KEY` is set, the kernel works in plaintext above the store seam, so the
dump is **decrypted**. An operator with shell access exfiltrates every field of every tenant in
one command, leaving no trace. Any CSV gating (Phase 6) is moot while this stands open.

Locked-mode rules for the CLI bulk paths:

- `--export-all` / `--export-base` require an **active root break-glass** (Phase 9) or a signed
  maintenance window — they are not routine commands.
- Each run emits an `export-job` evidence atom (operator identity, scope, atom count, purpose,
  reason) **before** the first byte streams.
- Default to **sealed** output: bodies stay AES-GCM-sealed and round-trip only under the same
  key. A plaintext bulk export requires break-glass and emits a distinct, louder evidence event.
- `--import-all` re-validates every atom against its model, **refuses** to import `log` /
  `sensitive-read` / other evidence atoms with foreign hashes, and re-chains evidence on import
  (Phase 11). Verbatim import that preserves `createdBy`/`lifecycle` is a forgery vector and is
  disabled in locked mode outside an import-specific break-glass.

**Dangerous-write guard.** In locked mode, direct writes (`POST`/`PATCH`/`PUT`/`DELETE`) to the
dangerous models below are rejected with a pointer to the change-request flow (Phase 8). The
*guard* ships now; the *workflow* comes later — deny first, build the maker-checker path after.

```text
model  grant  role  token  hook  migration  policy  condition
retention-policy  legal-hold  purpose  export-job  break-glass
```

---

## Phase 2 — Field sensitivity + redaction

> **Status: implemented (2026-05-31).** `sensitivity` is parsed off the field def (levels
> validated at model write — a typo'd level is a 400, so it can't silently downgrade to
> `internal`). A `canReveal()` gate sits in the two — and only two — per-field disclosure
> chokepoints (`redact()` for whole-atom/list/query/CSV/HTML, `readField()` for dotted
> traversal). In `locked` mode a `restricted` field is revealed **only** by an exact
> `model.field` read grant; a wildcard (`*`/`**`, **including a superuser's `**`**) does not,
> so it redacts everywhere by default. Outside `locked` mode sensitivity is inert metadata, so
> dev/prod disclosure is unchanged. 12 new assertions in `test.mjs` (a dev→locked store reboot,
> since model creation is blocked in locked by the Phase 1 guard).
>
> **Scoped / deferred, stated plainly:** (1) the `confidential` level is recorded but does
> nothing yet — it gates **export** in Phase 5. (2) Reveal under an active break-glass `**` is
> Phase 8; until then even root needs an exact grant. (3) `restricted` is **not** yet protected
> on the *write* side (a wildcard-write actor can blind-write it) — disclosure was the Phase 2
> deliverable. (4) **Known oracle gap:** a `restricted` field that is also `filterable`, or any
> value reachable by the `?q=` full-text scan, can still be used as an **equality/substring
> oracle** (the row matches and returns with the field redacted, but the match itself leaks the
> value). Closing the query-side oracle is a separate hardening pass, not done here.

Sensitivity lives on the model field definition. No separate classification engine.

```json
{
  "fields": {
    "name":  { "kind": "text",  "sensitivity": "internal" },
    "email": { "kind": "email", "sensitivity": "confidential" },
    "governmentIdLast4": { "kind": "text", "sensitivity": "restricted",
                           "encrypted": true, "index": "blind" },
    "eligibilityStatus": { "kind": "enum", "values": ["eligible","ineligible","unknown"],
                           "sensitivity": "restricted" }
  }
}
```

Levels: `public` · `internal` · `confidential` · `restricted`. Missing → `internal`.

- `restricted` fields require an explicit field grant (never satisfied by a wildcard in locked
  mode).
- `restricted` fields are redacted in HTML tables and JSON by default unless the actor holds
  reveal permission.
- `restricted` fields are excluded from every export path unless export is explicitly granted
  (Phase 6).
- Revealing a `restricted` field produces read evidence (Phase 5).

---

## Phase 3 — Purpose-bound sensitive reads

> **Status: implemented (2026-05-31).** A native `purpose` model ships in `coreAtoms()`
> (a governance/dangerous-write atom — defined in dev/bootstrap, not mintable in locked).
> Grants carry an optional `purpose` (a ref, or a list of them), passed through unstripped
> because grants ride as list items the validator does not recurse into. The request's
> purpose + reason are read from `X-Atomic-Purpose`/`X-Atomic-Reason` **or** `?purpose=`/
> `?reason=`, the purpose is resolved to a real, active `purpose` atom **once per request**
> (→ `actor._purposeOk`), and both are hung on a per-request **copy** of the actor (the
> resolved token/session atom is never mutated). `parseQuery` now reserves `purpose`/
> `reason` so a `?purpose=` on a list/CSV can't be misread as a row filter. The Phase 2
> `canReveal()` chokepoint gains the purpose gate: in `locked`, a `restricted` field is
> revealed only when an **exact** field-path read grant exists **and** the request carries
> a valid purpose that grant authorizes. **Enforcement is grant-match; the free-text reason
> is never consulted for access.** 16 assertions in `test.mjs` (the Phase 2 "exact grant
> reveals" cases moved here, since reveal now also requires a purpose).
>
> **Design decision, stated plainly:** a grant with **no** `purpose` authorizes **any**
> valid purpose — so an unconstrained exact grant still reveals, but the requester must
> declare *some* real purpose (recorded as evidence in Phase 4). Add a `purpose` to a grant
> to bind it to specific purposes. A purpose-bound grant reveals only for its own purpose;
> a different (even valid) purpose redacts.
>
> **Scoped / deferred, stated plainly:** (1) the resolved `reason` (and the purpose) are
> hung on the actor but **not yet written anywhere** — the `sensitive-read` evidence atom
> that captures them is Phase 4; today purpose-binding *gates* the read but produces no
> record. (2) Enforcement is `locked`-only; in dev/prod purpose is inert metadata, like
> sensitivity. (3) Hooks reading restricted fields carry no purpose, so they redact in
> locked mode — threading purpose through hook identity is a later concern. (4) The Phase 2
> query-side oracle gap (a `filterable` restricted field) is unchanged — purpose gates
> *disclosure*, not the equality/substring match.

Add a native `purpose` atom; extend grants with an optional `purpose`.

```json
{ "id": "purpose-eligibility-admin", "model": "atom://purpose",
  "attr": { "label": "Eligibility administration",
            "description": "Eligibility, compliance, or authorized administrative review." } }
```

```json
{ "path": "person.governmentIdLast4", "mode": "read",
  "purpose": "atom://purpose-eligibility-admin" }
```

**Enforcement is grant-match; the reason string is evidence only.** In locked mode, revealing a
restricted field requires (a) a matching read grant and (b) a request purpose that matches a
purpose the grant authorizes. The free-text `reason` is **self-asserted** — it is recorded as
evidence, never trusted for access. Do not confuse the two.

Request surface (normalized into request context):

```http
X-Atomic-Purpose: purpose-eligibility-admin
X-Atomic-Reason:  eligibility review
```

or `GET /person-123?purpose=purpose-eligibility-admin&reason=eligibility-review`.

---

## Phase 4 — Sensitive-read evidence (bounded — reads must not become unbounded writes)

> **Status: implemented (2026-05-31).** The `sensitive-read` model ships in `coreAtoms()`
> (an evidence model — on the import-refusal list; written only by the kernel). Reveals are
> accumulated in the projection path: `redact()` and `readField()` call `noteReveal()` only
> when a `restricted` field is *actually* disclosed, grouping by model on the request-scoped
> actor copy (`{ fields:Set, atoms:Set }` per model — so a list of N rows is ONE record with
> an N-element `atoms` list, never N records). A `reveal`/`revealCsv` wrapper at every GET
> read-response site calls `flushEvidence()` **after projection, before the bytes go out**:
> it writes one `sensitive-read` per model touched (actor, session, purpose, reason, model,
> fields, atoms, count, at) into the data's tenant shard via `seed` (bypassing the
> dangerous-write guard, like `logIt`). **Fail-closed in locked:** a failed evidence write
> throws `503` and the projected (restricted) body is never sent. A read that reveals nothing
> restricted writes nothing — `flushEvidence` is a no-op, so non-sensitive reads keep their
> millisecond path. 7 assertions in `test.mjs` (one-per-single-read, one-per-N-row-list,
> binds actor/purpose, captures reason, non-restricted writes nothing).
>
> **Scoped / deferred, stated plainly:** (1) **Locked-mode only.** The plan's `prod`
> best-effort path is NOT built: Phase 2 made sensitivity inert in `prod`, so `prod` reveals
> via wildcard without a purpose — recording there would mean an evidence atom missing its
> required `purpose`, plus new writes on the live read path. Recording stays a locked-mode
> governance feature end-to-end. (2) **Not yet tamper-evident.** sensitive-read atoms are
> written to the same store with no hash chain — forge/edit resistance is Phase 10. (3) The
> fail-closed *fault-injection* regression (Phase 11, item 8) needs a write-fault harness, not
> a behavioral assertion; the code path (throw → 503 → body withheld) is in place and the
> positive/bounded behaviors are tested. (4) HTML admin-UI renders flush through the same
> seam, so a UI reveal is recorded too; dedup by Set keeps it bounded.

Add a `sensitive-read` model. Record read evidence **only when a restricted field is actually
revealed**, and bound the cost so the read path stays fast.

```json
{ "id": "sensitive-read", "model": "atom://model",
  "attr": { "label": "Sensitive Read", "version": 1,
    "fields": {
      "actor":   { "kind": "ref", "to": "atom://token",  "required": true },
      "session": { "kind": "ref", "to": "atom://session" },
      "purpose": { "kind": "ref", "to": "atom://purpose", "required": true },
      "reason":  { "kind": "text" },
      "model":   { "kind": "text", "required": true, "filterable": true },
      "fields":  { "kind": "list", "of": "atom://_string" },
      "atoms":   { "kind": "list", "of": "atom://_string" },
      "query":   { "kind": "ref", "to": "atom://query" },
      "count":   { "kind": "integer" },
      "at":      { "kind": "datetime", "required": true, "filterable": true, "sortable": true } } } }
```

**Granularity — one evidence atom per request, never per field per row:**

- A single-atom read (`GET /<id>`) that reveals restricted fields → **one** `sensitive-read`
  recording that atom id and the revealed field names.
- A list/query read → **one** `sensitive-read` recording the model/query, the revealed field
  names, the matched atom ids (a list — one write, not N) and a count. "Who saw this person's
  SSN" is then answerable by querying evidence on `atoms` contains `person-123`.

This caps a sensitive request at a single evidence write and preserves the millisecond filtered
read for non-sensitive data — a read that reveals nothing restricted writes nothing.

**Fail mode (state it):**

- **Locked mode → fail-closed.** Write the evidence atom after projection but before flushing
  the restricted fields. If the evidence write fails, return `503` and do **not** send the
  restricted fields. Revealing data we cannot record violates the entire point.
- **`prod` mode → best-effort.** Evidence may be written async; a failure logs but does not
  block the response.

Append evidence in the **projection/redaction path**, not in every route.

---

## Phase 5 — Export control (CSV *and* the CLI paths from Phase 1)

> **Status: implemented (2026-05-31).** `export` is now a grant mode; `model.exports`
> (`disabled` | `grant` | `approval`, locked default `grant`) is a posture; `export-job`
> gained `model`/`fields`/`filters`. A `canExport()` gate plus a `gateExport()` pass run on
> every HTTP CSV path (model list, single-model query, cross-model `atom://atom` query): in
> locked mode a confidential **or** restricted field leaves in a CSV **only** under an exact
> `export`-mode grant on its path — never `read`, `write`, or even `all` (those don't imply
> export in locked). Ungranted sensitive fields become empty CSV cells (`atomsCsv` reads
> `dotGet`, so a deleted attr is blank), never a leak. Posture is enforced up front:
> `disabled` → 403, `approval` → 403 (pointer to the Phase 8 change request). A CSV export
> that carries ≥1 sensitive field records **one** `export-job` (actor, model, fields,
> filters, count, purpose, reason, `sealed:false`) through the **same fail-closed flush seam**
> as Phase 4 — so an export and any reveal it entails are evidenced together, before the bytes
> go out. 11 assertions in `test.mjs`.
>
> **Read vs. export is now distinct (and two earlier tests moved):** a valid purpose *reveals*
> a restricted field in JSON but does **not** *export* it to CSV without an export grant — so
> the Phase 3 "CSV includes with purpose" and Phase 4 "list via CSV" assertions were rewritten
> to use JSON reads (reveal) and a dedicated export grant (export).
>
> **Scoped / deferred, stated plainly:** (1) **Locked-mode only**, like the rest of the
> sensitivity stack. (2) **The CLI bulk paths already self-evidence (Phase 1)** and stay
> sealed/break-glass-gated in Phase 8 — this phase governs the *HTTP CSV* paths the Phase 1
> work didn't. (3) **`approval` posture rejects** rather than routing — the change-request
> workflow is Phase 7/8; deny-first, like the dangerous-write guard. (4) **Cross-model
> (`atom://atom`) CSV** gates each field by its atom's own model but cannot enforce a single
> model posture, so a `disabled` model's *non-sensitive* fields can still appear in an
> `atom://atom` export — single-model CSV (the common path) enforces posture fully. (5) The
> export-job is written to the same store, **not yet tamper-evident** (Phase 10).

Add an `export` grant mode and a model-level export posture.

```json
{ "path": "person.email", "mode": "export", "purpose": "atom://purpose-eligibility-admin" }
```

```json
{ "exports": "disabled" | "grant" | "approval" }     // default in locked mode: "grant"
```

- `read` does **not** imply `export`; `write` does not imply `export`; `all` implies export
  only outside locked mode.
- In locked mode, any export (HTTP CSV *or* CLI bulk from Phase 1) touching confidential or
  restricted fields requires an explicit `export` grant and emits an `export-job` atom
  recording actor, model/query, fields, filters, count, purpose, reason, timestamp.
- `exports: "approval"` routes the export through a change request (Phase 8) before it runs.

---

## Phase 6 — Hook and migration allowlists

> **Status: implemented (2026-05-31).** `ATOMIC_HOOKS` / `ATOMIC_MIGRATIONS` parse once into
> sets of allowed `run` basenames. In `runHooks`, locked + a hook whose `run` isn't listed →
> **skip** (never `import` or execute) and write a `hook-skipped` `log` against the target atom
> (evidence: which hook, which run, when — a silently-disabled automation leaves a trace). In
> `applyMigration` (op `custom`), locked + a `run` not listed → **fail closed** (`throw 403`)
> rather than silently returning the un-transformed bag — so an atom never reads back through
> unvetted code. Empty/unset allowlists mean nothing runs (the secure default). Inert outside
> locked. 6 assertions in `test.mjs` (dev hook runs; locked-no-allowlist hook skips + logs and
> migration 403s; locked-allowlisted both run).
>
> **One subtlety the build surfaced:** the boot-time schema sweep (`migrate → sweepAll →
> sweepModel → bringForward`) would have crashed the kernel on a fail-closed migration. Fixed
> by catching per-atom in `sweepModel` — an un-allowlisted atom is **left behind its version**
> at boot and fails closed only on an actual READ (where the requester sees the 403), so the
> server still boots. Testing the migration path also required injecting a behind-version atom
> via `--import-all` (the eager dev sweep otherwise migrates everything before locked boot).
>
> **Scoped / deferred, stated plainly:** (1) **Locked-mode only.** (2) Hook/migration atoms are
> already dangerous-write models (Phase 1), so add/modify already needs the change-request path
> (Phase 7). (3) Hook `patch`/`upsert` still runs under the hook's own grants — unchanged. (4)
> Only the **single-atom read** path brings atoms forward, so a *list* of behind atoms returns
> their raw (un-transformed) prior shape rather than failing closed — the unvetted transform
> still never runs, which is the security property; surfacing list-side staleness is cosmetic.

Hook/migration `run` is already locked to safe basenames. In locked mode, add an explicit
allowlist:

```bash
ATOMIC_HOOKS=census-district,normalize-email
ATOMIC_MIGRATIONS=person-v2-normalize
```

- Locked + hook not allowlisted → skip and emit evidence.
- Locked + custom migration not allowlisted → **fail closed**.
- Hook and migration atoms are dangerous atoms (require a change request to add/modify).
- Hook patch/upsert continues to run under the hook's own grants.

---

## Phase 7 — Change requests + approval (the maker-checker workflow)

The Phase 1 guard already blocks direct edits to dangerous atoms. This phase adds the path to
make those edits safely.

```json
{ "model": "atom://change-request",
  "attr": { "target": "atom://person", "op": "update",
            "before": {}, "after": {}, "diff": [],
            "status": "draft|submitted|approved|rejected|applied", "reason": "..." } }
```

```json
{ "model": "atom://approval",
  "attr": { "change": "atom://cr-123", "approver": "atom://tok-security-admin",
            "decision": "approved|rejected", "reason": "...", "at": "..." } }
```

- **Maker cannot approve their own change.**
- A change request must show a diff.
- Applying a change runs through the **normal existing write path** (so it re-validates, checks
  grants, and produces a `log` + evidence).
- Rejected changes are retained.

**Bootstrap (the paradox the earlier draft left open):** if editing grants needs an approved
change request, and approval needs an approver with the right grant, the first approver must be
establishable **out of band** — an env-configured root identity (`ATOMIC_ADMIN_SECRET`) that can
seed the first approver and is itself only usable via break-glass evidence in locked mode. Name
this explicitly so locked mode is recoverable, not bricked.

---

## Phase 8 — Break-glass access

Wildcard root access is sometimes necessary, but it must be noisy and temporary.

```json
{ "model": "atom://break-glass",
  "attr": { "actor": "atom://tok-admin", "reason": "incident response",
            "expiresAt": "2026-06-01T00:00:00Z",
            "grants": [ { "path": "**", "mode": "all" } ],
            "status": "active|expired|revoked" } }
```

- In locked mode, `**` grants are rejected unless tied to an **active** break-glass.
- Break-glass requires a reason and an expiration; activation emits evidence.
- Every sensitive read under break-glass logs a `sensitive-read` with the break-glass reason.
- Expired break-glass stops working automatically.
- Implementation: reuse the existing grant system — expand an actor's effective grants only
  while an active, unexpired break-glass atom exists for them. No parallel permission path.

Break-glass is also the key that unlocks Phase 1's CLI bulk export and Phase 7's bootstrap.

---

## Phase 9 — Legal hold + retention hardening

Expiration today is lazy and non-destructive — keep that. Add explicit holds.

```json
{ "model": "atom://legal-hold",
  "attr": { "target": "atom://person-123", "scope": "atom|tenant|model|query",
            "reason": "hold", "status": "active|released",
            "createdAt": "...", "releasedAt": null } }
```

- Retire/delete is blocked for held atoms; purge/export/delete must check active holds.
- Expiration may hide a held atom from normal reads but can never destroy it.
- `--audit` reports expired-but-held counts.
- Do **not** build physical purging first. Get soft-delete + hold correct before hard deletion.

---

## Phase 10 — Tamper-evident evidence (multi-writer correct)

> This is the phase the earlier draft got wrong. An in-memory `lastEvidenceHash` rebuilt on
> boot only works for a single-node, single writer. Atomic's Postgres driver is sold as MVCC
> "many writers," and more than one `atomic` process already runs under pm2. A global in-memory
> chain head forks the moment two writers append concurrently, and `--audit` fails.

Make evidence (`log`, `sensitive-read`, `export-job`, `change-request`, `approval`,
`break-glass`) tamper-evident with **per-tenant hash chains and a persisted head**:

```json
{ "prev": "sha256…", "hash": "sha256(prev + canonical_event)", "seq": 42 }
```

- One chain **per tenant** (per shard), so cross-tenant writes stay concurrent — the chain
  serializes only within a tenant, not globally.
- The chain head is a **persisted** value (a head row / head atom per tenant), never only
  in memory.
- Appending an evidence atom happens **inside one store transaction** that serializes per
  tenant: take a per-tenant lock (`pg_advisory_xact_lock(hashtext(tenant))` on Postgres; the
  single writer satisfies it trivially on SQLite), read the head, compute
  `hash(prev + canonical_event)`, write the evidence atom with `{prev, hash, seq}`, advance the
  head, commit. No torn chains, no cross-process races.
- `--audit` re-walks each tenant's chain in `seq` order and recomputes every hash; a break is a
  finding.
- Uses only `node:crypto`. No dependency.

Accept the cost honestly: evidence writes within a tenant serialize. For the sensitive-read and
governance volumes this targets, that is fine; if a tenant ever needs higher evidence
throughput, shard the chain below the tenant — but do not pretend the chain is free.

---

## Phase 11 — Locked-mode audit + self-tests

The atom-as-test structure is one of Atomic's best features. Add locked-mode coverage to both
the black-box HTTP suite and the atom self-tests before declaring readiness:

1. In-memory store rejected in locked mode.
2. Missing `ATOMIC_KEY` rejected in locked mode.
3. Open-login token rejected in locked mode.
4. Direct edit of each dangerous model rejected in locked mode.
5. Wildcard `**` grant rejected without active break-glass.
6. Restricted field hidden without explicit grant; hidden without purpose; visible with both.
7. Sensitive read creates exactly **one** `sensitive-read` for a list of N rows (not N).
8. Sensitive read fails **closed** when evidence cannot be written (locked mode).
9. HTTP CSV export rejected without export grant; export with restricted field creates an
   `export-job`.
10. **`--export-all` refused without break-glass; emits `export-job`; default output is sealed.**
11. **`--import-all` rejects foreign-hash evidence atoms and re-chains.**
12. Maker cannot approve own change request; approved change applies via the normal write path.
13. Legal hold blocks retire/delete.
14. Hook not in allowlist does not run; custom migration not in allowlist fails closed.
15. **Evidence hash chain verifies in `--audit` after concurrent writes from two processes.**
16. Log/evidence atoms cannot be edited or deleted through normal APIs.
17. Break-glass requires reason + expiration; expired break-glass stops working.

Items 7, 8, 10, 11, and 15 are the regression tests for the three problems this plan fixes.

---

## Minimal new atom types

```text
purpose  sensitive-read  change-request  approval
legal-hold  retention-policy  export-job  break-glass
```

Add `classification` only if sensitivity needs reusable descriptions — prefer field-level
metadata first.

---

## Implementation order (ranked by leak-size-to-code)

1. ✅ `ATOMIC_MODE` + locked boot checks (Phase 0).
2. ✅ **Close the bulk-export hole + dangerous-write guard (Phase 1)** — biggest leak, least code.
3. ✅ Field `sensitivity` + restricted redaction (Phase 2).
4. ✅ Purpose parsing + purpose-bound restricted reads (Phase 3).
5. ✅ Bounded `sensitive-read` evidence with fail-closed semantics (Phase 4).
6. ✅ Explicit `export` grant mode + CSV/CLI export audit (Phase 5).
7. ✅ Hook/migration allowlists (Phase 6).
8. Change-request + approval, with the bootstrap path (Phase 7).
9. Break-glass (Phase 8).
10. Legal hold + retention hardening (Phase 9).
11. Per-tenant hash-chained evidence with persisted head (Phase 10).
12. Locked-mode `--audit` checks + locked-mode test suite (Phase 11).

Steps 1–2 deliver the most safety per line and stop the silent-exfil path immediately.

---

## Readiness definition

Atomic is minimally ready for a sensitive enterprise pilot when all of this is true:

- `ATOMIC_MODE=locked` exists and refuses unsafe boot configurations.
- **No export path — CSV or CLI bulk — leaks restricted data without an explicit grant and an
  `export-job` evidence record.**
- Restricted fields redact by default; restricted reads require purpose and produce bounded,
  fail-closed evidence.
- Dangerous atoms require approved change requests, and locked mode is recoverable (bootstrap
  path defined).
- Hooks and custom migrations are allowlisted.
- Legal holds block deletion.
- Break-glass is temporary, reasoned, and logged.
- **The per-tenant evidence chain verifies in `npm run audit` after concurrent multi-writer
  appends.**
- Locked-mode tests pass.

Until then, Atomic should not be the direct system of record for high-sensitivity data. It can
safely continue as the kernel prototype, control-plane model, admin-UI generator, and testbed.

---

## Design mantra

Keep the system coherent by making the kernel **stricter**, accepting that it also grows
**larger** — never by adding more stack.

```text
same atom shape · same HTTP surface · same generated UI
same store seam · same permission system · same test philosophy

+ locked mode
+ every export path governed (CSV and CLI bulk)
+ field sensitivity
+ purpose-bound access
+ bounded, fail-closed sensitive-read evidence
+ approved governance changes (recoverable bootstrap)
+ legal hold · break-glass
+ per-tenant, multi-writer-correct evidence chain
```

Atomic does not need more stack. Atomic needs fewer escape hatches — and the biggest escape
hatch was the one nobody was watching: bulk export.

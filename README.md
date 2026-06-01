# Atomic

> One record shape for everything — data, schema, identity, permissions, queries, the
> audit log, even the UI. Each is an **atom**, and one kernel governs them all.

![node](https://img.shields.io/badge/node-%E2%89%A522.5-3f6df6)
![dependencies](https://img.shields.io/badge/dependencies-0%20required-brightgreen)
![kernel](https://img.shields.io/badge/kernel-single%20file-blue)
![tests](https://img.shields.io/badge/tests-257%20passing-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

Atomic is a single-file kernel for graph-relational data with no required dependencies (the
optional Postgres driver pulls in `pg`). Every record it holds — a row of data, a type
definition, a permission grant, a saved query, an audit-log entry, even a test — is the same
shape:

```json
{ "id": "...", "model": "atom://...", "manifest": "...", "attr": { }, "lifecycle": { } }
```

One kernel validates, stores, queries, permissions, and renders all of them. The HTTP API
and the web UI are both generated from the atoms themselves, so there is no separate ORM,
query builder, permission system, or UI framework to wire together — and no generated code
to keep in sync. The whole thing is `atomic.mjs`: about 3,500 lines, zero required
dependencies.

[Why](#why) · [Quick start](#quick-start) · [Concepts](#concepts) · [How it works](#how-it-works) · [HTTP API](#http-api) · [Identity & access](#identity--access) · [Locked mode](#locked-mode) · [Lifecycle](#lifecycle) · [The generated UI](#the-generated-ui) · [Persistence](#persistence) · [Mechanism reference](#mechanism-reference) · [Configuration](#configuration) · [CLI](#cli) · [Testing & governance](#testing--governance) · [Status](#status) · [License](#license)

---

## Why

A typical application splits one idea across many representations: a SQL schema, an ORM, a
stack of migration files, a REST or GraphQL layer, a permissions module, a UI framework, and
the generated glue that holds them together. Every boundary between those layers is a place
where they can drift apart, and most of the work of building software is keeping them aligned.

Atomic removes the boundaries. There is one record — the atom — and the things that would
normally be *other systems* are just more atoms:

- A **type** is an atom (a `model`). The schema is data you can read, query, diff, and migrate
  with the same tools you use on everything else.
- A **permission** is an atom (a `grant`). Access control is data, not code.
- A **saved query** is an atom (a `query`). So is the **audit log**, a **migration**, and a
  **test**.

Because the schema is data, the API and the UI are *derived* from it at request time rather
than generated to disk. Define a model and you immediately have a validated REST endpoint, a
CSV import/export, a permission surface, and a rendered, editable web page for it — with
nothing to regenerate and nothing to fall out of sync. That is the entire bet: **collapse the
stack into one shape, and let one kernel govern it.**

---

## Quick start

**Requirements:** Node ≥ 22.5 (for the built-in `node:sqlite`). Node ≥ 24 runs it unflagged;
on 22.x the SQLite binding is behind an experimental flag. In-memory mode needs nothing.

```bash
# in-memory (nothing persists) — http://localhost:3040
npm start

# durable: point ATOMIC_STORE at a directory (creates <dir>/atoms.db, WAL mode)
ATOMIC_STORE=./data npm start

# scale-out: point ATOMIC_DB at a Postgres URL (needs the optional `pg` dependency)
ATOMIC_DB=postgres://localhost/atomic npm start

# load four demo tenants (a PAC, an advocacy program, a hybrid, a household)
npm run seed

# verify
npm test         # 257 black-box HTTP assertions
npm run check    # the kernel's own tests, which are themselves atoms
npm run audit    # structural invariants (exits non-zero on any finding)
```

**Signing in.** A token's public id is never a credential. Humans sign in by magic-link
(`POST /auth { email }` → a link → a session cookie; with no mailer configured in dev, the
link is returned in the response). Integrations present a token's **API secret** as
`Authorization: Bearer <secret>` — shown once when the token is created. An admin can be given
a fixed secret via `ATOMIC_ADMIN_SECRET` (used by `npm run seed` and CI); otherwise the admin
is magic-link only.

---

## Concepts

Atomic has six primitives.

| Primitive | What it is |
|-----------|------------|
| **Atom**  | A record: `{ id, model, manifest, attr, lifecycle }`. Everything is one. |
| **Model** | An atom that defines a type — its fields, validation, and rules. Validates an atom's `attr` on write. |
| **Query** | An atom describing a saved query over a model's atoms — `{ over, match, sort, page }` — run by id and rendered as a table. |
| **Path**  | A dotted expression that reads across fields and edges, under the reader's permissions. |
| **Logic** | A rule (a path predicate) or a transform (a vetted handler / hook). |
| **Log**   | An append-only atom recording every change. |

### The atom

```json
{
  "id": "7b8f-2f0c",
  "model": "atom://contact",
  "manifest": "Jane Roe, VP Eng at Northwind",
  "attr": {
    "name": "Jane Roe",
    "email": "jane@northwind.com",
    "company": "atom://northwind"
  },
  "lifecycle": {
    "status": "active",
    "version": 3,
    "modelVersion": 1,
    "createdAt": "2026-05-28T12:00:00Z",
    "createdBy": "atom://tok-amy",
    "parent": "atom://acme"
  }
}
```

- `id` — opaque and immutable. The reference to this atom is `atom://7b8f-2f0c`.
- `model` — a pointer to the model atom that defines this record's type.
- `manifest` — a free-text label, full-text indexed.
- `attr` — the record's values; the model validates them. A value that is an `atom://` ref is
  a graph edge.
- `lifecycle` — kernel-managed: status, version (a write counter), the `modelVersion` the atom
  was written under, the `parent` (its tenant), and the creating/updating actor and time.

### The model

A model is an atom whose `attr.fields` declares a type. The kernel's own types — `model`,
`token`, `query`, `log`, and the rest — are themselves model atoms, which is what makes the
schema queryable.

```json
{
  "id": "contact", "model": "atom://model", "manifest": "A person",
  "attr": {
    "label": "Contact", "version": 1,
    "fields": {
      "name":    { "kind": "text", "required": true },
      "email":   { "kind": "email" },
      "company": { "kind": "ref", "to": "atom://company", "inverse": "contacts" },
      "address": { "kind": "embed", "of": "atom://address", "required": true }
    }
  }
}
```

**Field kinds:** `text`, `longtext`, `email`, `url`, `uuid`, `datetime`, `integer`, `number`,
`boolean`, `enum` (`values`), `ref` (`to`, `inverse`, `onDelete`), `list` (`of`), `map`,
`json`, and `embed` (`of`). Common modifiers: `required`, `unique`, `default`, `min`/`max`,
`minLength`/`maxLength`, `pattern`, `filterable`/`sortable` (index the field — see
[indexed reads](#how-it-works)), and `sensitivity` (`public` · `internal` · `confidential` ·
`restricted`; default `internal`) — which gates disclosure and export in
[locked mode](#locked-mode) and is inert metadata otherwise.

### References: `atom://` vs `embed://`

- **`atom://x`** is an edge to a standalone, shareable atom. It is stored as a live link, and
  reads see `x`'s current values. Declaring an `inverse` on the field makes the backlink
  queryable.
- **`embed://x`** (equivalently `{ kind: "embed", of: "atom://x" }`) inlines another model's
  shape directly into this atom. The values live in the parent's `attr`, are validated against
  `x`, and carry no `id` or `lifecycle` of their own. The *same* shape can be reused under
  multiple fields — `home` and `work` can both be `embed://address`.

### Rules

A model may carry `rules.read` / `rules.write` — a predicate that runs *in addition* to grants
and tenancy (an atom is readable/writable only if its grants **and** its rule pass). A rule is
one comparison — `LEFT == RIGHT` or `LEFT != RIGHT` — where each side is a literal (`true`,
`'text'`, `atom://id`) or a dotted path read, against the **atom** by default or the **actor**
with an `actor.` prefix. Anything the safe evaluator can't parse denies (access is never granted
by error).

```json
{ "id": "house", "model": "atom://model",
  "attr": {
    "label": "House", "version": 1,
    "fields": { "home": { "kind": "ref", "to": "atom://house" } },
    "rules":  { "write": "home == actor.house" }
  } }
```

A `house` atom is then writable only by the token whose own `house` field points at it —
field-level ownership, expressed as data. (`tenant == actor.tenant` is another common one.)

### Queries

A `query` atom is a saved, parameterized read over a model, run by id (`GET /<query-id>`) and
rendered as a table or page:

```json
{ "id": "log.byAtom", "model": "atom://query",
  "attr": {
    "over":   "atom://log",
    "params": { "atom": { "kind": "ref", "to": "atom://atom" } },
    "match":  { "atom": "params.atom" },
    "sort":   [{ "at": "asc" }],
    "returns": "set"
  } }
```

- **`over`** — the model to read (or `atom://atom` for every model).
- **`params`** — typed inputs, filled from the query string: `GET /log.byAtom?atom=atom://c1`.
- **`match`** — `{ field: literal }` or `{ field: "params.<name>" }`; equality on a `filterable`
  field pushes into the index.
- **`sort`** — `[{ field: "asc" | "desc" }]`. Add `page: { cursor, limit }` for cursor
  pagination (`returns: "page"`); otherwise `returns: "set"`.

---

## How it works

Every request runs through the same short pipeline, regardless of whether it touches a
contact, a permission grant, or a model definition:

```
resolve actor → validate against the model → check grants (per field)
              → run hooks → append to the log → project (redact) → render (JSON or HTML)
```

Nothing in that pipeline is specific to a type. A `model` is validated and permissioned by
exactly the same code that validates and permissions a `contact`, because both are atoms and
the rules for each live in *their* model.

**Storage is a port, not the product.** The kernel talks to storage through one narrow seam —
read a set of atoms for an actor, write an atom, watch a model for change — and nothing above
that seam knows where the bytes live. That makes the backend a swap: in-memory, embedded
SQLite, or Postgres, with no change to validation, permissions, or rendering. The store holds
opaque rows; it never learns what a `contact` *is*. All meaning stays in the kernel.

**Indexed reads.** Declare a field `filterable` or `sortable` and the kernel maintains a
generic secondary index over it (alongside built-in `createdAt`/`updatedAt`). Filtering,
range, sort, and pagination are then pushed entirely into the store, so a read never
materializes a model's full set — a filtered, sorted page over a 100M-row model stays in the
millisecond range and is always scoped to one tenant. Above the store port the index is just
opaque `(model, field, value, id)` rows; the store still learns nothing about the schema.

---

## HTTP API

The surface is generated from the atoms. The HTTP method selects an operation, and the
operation is gated by the actor's grants.

| Method | Operation | Notes |
|--------|-----------|-------|
| `GET /<id>` | read | the atom (HTML with `Accept: text/html`, otherwise JSON) |
| `GET /<model>` | list | the model's atoms; `field=v`, `field>=n`, `sort=-field`, `limit`, `cursor`, CSV (indexed on declared fields) |
| `GET /<id>.<field>.<edge>…` | path read | traverse edges under the reader's permissions |
| `GET /<query-id>` | run query | run a saved `query` atom by id and return its result set/page |
| `POST /<model>` | create | one atom, a JSON array (bulk), or a `text/csv` body (import) |
| `PATCH /<id>` | update | merge `attr`; honors `If-Match` for optimistic concurrency |
| `PUT /<id>` | replace | replace `attr` wholesale |
| `DELETE /<id>` | retire | soft-delete (sets `status: retired`) |
| `POST /tx` | transaction | a JSON array of operations, applied all-or-nothing |
| `POST /base` | provision | superuser-only; `{ name }` → a new tenant + open-login token + share URL |

```bash
# $SECRET is a token's API secret (shown once at creation), or ATOMIC_ADMIN_SECRET.

# create
curl -X POST localhost:3040/contact -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' \
  -d '{"id":"c1","attr":{"name":"Jane Roe","email":"jane@northwind.com"}}'

# read · list · filter · sort
curl localhost:3040/c1 -H "authorization: Bearer $SECRET"
curl 'localhost:3040/contact?email=jane@northwind.com&sort=-createdAt' -H "authorization: Bearer $SECRET"

# update one field with optimistic concurrency
curl -X PATCH localhost:3040/c1 -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' -H 'if-match: 1' \
  -d '{"attr":{"name":"Jane R."}}'
```

### Transactions

`POST /tx` applies a batch of writes all-or-nothing; any failure rolls the whole batch back.

```bash
curl -X POST localhost:3040/tx -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' -d '[
    {"op":"create","model":"contact","id":"c2","attr":{"name":"A"}},
    {"op":"update","id":"c1","ifMatch":2,"attr":{"name":"B"}},
    {"op":"delete","id":"c-old"}
  ]'
# → { "ok": true, "results": [...] }   (or the whole batch rolls back)
```

### Referential integrity

A `ref` field carries an `onDelete` policy — `restrict` (the default: refuse to delete a
still-referenced atom), `cascade` (delete the referrers too), or `null` (clear the referring
cells). It is enforced at delete time, inside the transaction, so a store can never end up
pointing at a deleted atom and a half-applied cascade can't corrupt it.

### CSV

Every model table and query result has an export (`?as=csv`) and a template
(`?as=template`); embedded shapes flatten into dotted columns (`address.street`). Import is a
`POST` of a `text/csv` body (or a JSON array); add `?atomic=1` to run the whole import as one
transaction.

---

## Identity & access

- **Tokens.** A `token` atom is an identity carrying `grants` and/or `roles`. Its public **id
  is never a credential** — ids leak through `createdBy`, refs, and path reads. Each token
  holds a high-entropy **API secret**, stored only as a hash and shown once at creation;
  present it as `Authorization: Bearer <secret>`. A session id works as a bearer too
  (`Bearer sess-…`), identical to the cookie.
- **Grants.** `{ path, mode }`, where `mode` is `read` · `create` · `update` · `delete` ·
  `write` (the mutation superset — it does **not** imply read) · `all` · `export` (CSV export of
  sensitive fields, a right of its own — see [Locked mode](#locked-mode)). Paths are `model`,
  `model.field`, or wildcards (`*`, `**`). A grant may also carry a `purpose` (locked mode).
- **Roles.** A `role` atom bundles reusable grants; a token's effective grants are its own plus
  its roles'. A token can only wear a role within its own grants (attenuation).
- **Tenancy is structural.** `lifecycle.parent` forms a tenant tree. You may write an atom only
  if you share its tenant ancestor (or you are a tenant-less root). Global atoms are
  world-readable and root-writable.
- **Per-field redaction.** A read returns only the fields the actor is granted; path reads
  honor scope, grants, and rules at every hop. Field `sensitivity`, purpose-bound reads,
  read/export evidence, maker-checker change control, and break-glass are the
  **[locked mode](#locked-mode)** hardening layered on top of this — see below.
- **One-click bases.** `POST /base { name }` (or `node atomic.mjs --new-base "<name>"`)
  provisions a tenant and an open-login token in one transaction and returns a **share URL** —
  open it and you are one-clicked into that base as a full, tenant-confined session.

---

## Locked mode

Everything above is the always-on model. **`ATOMIC_MODE=locked`** hardens the *same* kernel —
no new services, no second app — into a posture fit to be the system of record for sensitive
data. It is **off by default** (`dev`); a deployment opts in, and the kernel then refuses to boot
without a durable store, a real auth path, and `ATOMIC_KEY`.

The threats it answers: an over-broad grant, a compromised insider with a valid token, an
operator with shell/DB access, silent exfiltration through an export, and tampering with the
record of what happened. The guarantee is that **who did what, when, and why** is answerable from
Atomic's own evidence — not from infrastructure logs. Everything below is enforced in the
*existing* read/write/export paths; nothing is a separate service.

- **Field sensitivity.** A model field may be `confidential` or `restricted`. A `restricted`
  field is revealed only by an **exact** `model.field` read grant — never a wildcard, not even a
  superuser's `**` — so it redacts out of reads, lists, queries, path traversal, and CSV by
  default.
- **Purpose-bound reads.** Revealing a restricted field *also* requires the request to declare a
  **purpose** (`X-Atomic-Purpose: <id>` or `?purpose=`) that the grant authorizes. A free-text
  `X-Atomic-Reason` is recorded as evidence but never grants access.
- **Bounded, fail-closed evidence.** Each disclosure writes one `sensitive-read` atom (one per
  model per request, *not* per row), recorded *before* the bytes are flushed — if it can't be
  written, the read returns `503` and the data is withheld.
- **Export is a separate right.** Reading a field and exporting it are different: a
  confidential/restricted field leaves in a CSV only under an explicit `export`-mode grant
  (never `read`/`write`/`all`); a model's `exports` posture (`disabled` · `grant` · `approval`)
  is enforced; and a sensitive export records an `export-job`.
- **Governed change (maker-checker).** Governance atoms (`model`, `token`, `hook`, `migration`,
  `policy`, `legal-hold`, …) can't be edited directly. A `change-request` proposes the edit and a
  separate `approval` applies it through the normal write path — and the **maker can't approve
  their own change**.
- **Break-glass.** A `**` grant is inert unless an **active break-glass** restores it. Break-glass
  is admin-secret-only (`POST /break-glass`), requires a reason and a future expiry, is logged,
  and lapses on its own; while active it grants full access and stamps every sensitive read with
  its reason. It is also the recovery path — a `**` superuser can do nothing in locked mode until
  the glass is broken.
- **Hook & migration allowlists.** `ATOMIC_HOOKS` / `ATOMIC_MIGRATIONS` name the script basenames
  that may run. An unlisted hook is skipped (and records evidence); an unlisted custom migration
  fails closed.
- **Tamper-evident evidence.** Every evidence atom links into a per-tenant **hash chain**
  (`sha256(prev + event)`, a persisted head, appended under a per-tenant lock so concurrent
  writers can't fork it). Evidence is **append-only** — no API path edits or deletes it — and
  `npm run audit` re-walks each chain, so a tampered, deleted, or inserted record is a finding.

Two guarantees hold in **every** mode, not just locked: a **legal hold** (see
[Lifecycle](#lifecycle)) blocks deletion unconditionally, and evidence atoms are append-only.

### Governance atom types

`purpose` · `sensitive-read` · `export-job` · `change-request` · `approval` · `break-glass` ·
`legal-hold` · `evhead` (the per-tenant evidence-chain head). They are ordinary models — readable
and queryable like everything else.

### The governance endpoints

These are ordinary `POST`s; the kernel fills the derived fields (a change-request's
`before`/`diff`/`status`, an approval's `approver`/`at`, the break-glass `actor`/`status`):

```jsonc
// 1. the maker proposes a governance edit (kernel records before + diff, status: submitted)
POST /change-request  { "attr": { "target": "atom://tok-eng", "op": "update",
                                  "after": { "email": "eng@x.com" }, "reason": "rotate contact" } }

// 2. a DIFFERENT actor approves — applies it through the normal write path (maker ≠ approver)
POST /approval        { "attr": { "change": "atom://cr-1f3a", "decision": "approved" } }

// emergency: recover ** — admin secret only, reason + future expiry mandatory
POST /break-glass     { "attr": { "reason": "incident 412", "expiresAt": "2026-06-02T00:00:00Z" } }

// place a litigation hold (a governance atom: direct in dev; via break-glass or a change-request in locked)
POST /legal-hold      { "attr": { "target": "atom://person-123", "scope": "atom",
                                  "reason": "subpoena", "status": "active" } }
```

A `change-request` `op` is `create` (then `target` is the model id) · `update` · `replace` ·
`delete`. Releasing a hold is an `update` to `status: released`.

### Turning it on

Set `ATOMIC_MODE=locked`, which then *requires* `ATOMIC_KEY`, a durable store, and
`ATOMIC_ADMIN_SECRET` or a mailer — the boot fails closed otherwise. The first move on a locked
deployment is `POST /break-glass` (with the admin secret) to recover `**`, then seed your tokens,
roles, purposes, and holds. **Deliberately out of scope** (handle at the proxy/infra layer):
SSO/MFA, KMS and key rotation, and network rate-limiting/DoS.

---

## Lifecycle

- **Hooks.** A `hook` is a capability atom `{ run, grants }` registered in an atom's (or a
  model's) `lifecycle.hooks`, keyed `create` / `update` / `delete`. It runs `scripts/<run>.mjs`
  under its *own* grants — the caller needs no invoke permission, and `run` is locked to a safe
  basename. The handler is `export default async (atom, { patch, upsert, getAtom, ref, refId })
  => {…}`: `patch(fields)` writes fields onto the triggering atom, and `upsert(model, id, attr)`
  creates-or-updates and links a related atom — both under the hook's own grants. (Example:
  `scripts/census-district.mjs` geocodes an address and links a congressional-district atom on
  write.)
- **Expiration.** `lifecycle.expiration` points at a `policy` (a set of `condition` atoms). An
  atom is expired when all of its policy's conditions hold; expired atoms are filtered out of
  reads but never mutated — editing one brings it back. The default policy is "not updated in
  three years."
- **Legal hold.** A `legal-hold` atom `{ target, scope, reason, status }` (scope `atom` /
  `tenant` / `model`) blocks retire/delete of the atoms it covers — **unconditionally**, even
  under break-glass or an approved change-request. Expiration may hide a held atom, but a hold
  guarantees it is never destroyed. (`--audit` reports the expired-but-held count.)
- **Schema migration.** Each model carries a `version`, and each atom records the
  `modelVersion` it was written under. A `migration` atom is a one-way step (`rename` or
  `default` from a `spec`, or a vetted `custom` handler). Behind atoms are brought forward
  lazily on read, on schema change, and to completion on boot — then persisted and logged.

---

## The generated UI

Request any atom with `Accept: text/html` and the kernel renders an interface from the same
atoms: recursive atom rendering, sortable tables, model-driven create/edit forms (embed →
nested table, list → repeater, ref → autocomplete), query forms, and a backlink ref-map. The
stylesheet uses no classes and no ids — every rule targets a semantic element.

**Editable grid.** Every model table is inline-editable exactly where the viewer holds an
update grant: text and number cells are `contenteditable`, enums become `<select>`, booleans a
checkbox (refs, embeds, and lists edit via the row form). Each edit is a single-field `PATCH`
with `If-Match`, so per-field grants and optimistic concurrency apply automatically — an
unauthorized cell isn't editable, and a stale version reloads the row. The client is one
static, same-origin `/app.js` with no inline script under a strict CSP.

---

## Persistence

Storage sits behind the kernel's store port; selecting a driver is one environment variable
and changes nothing above the port.

- **In-memory** by default — nothing persists.
- **SQLite** when `ATOMIC_STORE=<dir>` is set: state lives in `<dir>/atoms.db` (WAL-mode SQLite
  via the built-in `node:sqlite`). Two tables — `atom`, indexed on tenant and type, and the
  secondary `idx`. State is authoritative in the table with no boot-time replay, and reads are
  scoped to a tenant and type in SQL, so a read never materializes another tenant's atoms.
  Single-node, single-writer.
- **Postgres** when `ATOMIC_DB=<postgres-url>` is set: the same two tables on Postgres, with
  MVCC concurrency (many writers), connection pooling, and managed backups, replication, and
  HA. The `idx.value` column is `jsonb`, so numbers order numerically and strings lexically —
  equality, range, and sort stay indexed, exactly as on SQLite. Transactions pin a pooled
  connection and route their own operations to it, so a concurrent request can never land on a
  transaction's connection. (Postgres needs the one optional dependency, `pg`, loaded only when
  `ATOMIC_DB` is set; the SQLite and in-memory paths stay dependency-free.)
- **Encrypted at rest** when `ATOMIC_KEY` is set (64-hex, or a passphrase stretched with
  scrypt): each atom's body is sealed with AES-256-GCM — confidential and tamper-evident —
  while the structural columns stay plaintext for routing. Under a key, indexed values are
  blind-hashed (equality only, no range or sort).

Migrate between any two drivers with `node atomic.mjs --export-all` and `--import-all`.

---

## Mechanism reference

The precise rules behind each subsystem. Every behavior in the kernel is one of these
mechanisms applied to atoms; nothing here is type-specific.

### Request lifecycle

One handler serves every request. It parses the URL and cookies, resolves the actor, and — in
`prod`/`locked` — annotates a **per-request copy** of the actor with the request's `purpose`,
`reason`, and active break-glass (so the effective grants are recomputed per request and a
break-glass's wall-clock expiry is honored). It then routes by method + path:

```
resolve actor (+ per-request context) → route
  read   →  load → bringForward (lazy migrate) → project (redact) → flush evidence → render
  write  →  guard → validate + grants → mutate → log (+ chain) → run hooks → render
```

Reads project through `redact`; writes run `create` / `writeAtom` / `retire`, then `runHooks`.
Responses negotiate JSON (default), HTML (`Accept: text/html` or `?as=html`), or CSV
(`?as=csv`). Every response carries `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy:
no-referrer`; HTML adds a strict CSP (`default-src 'none'; script-src 'self'; …`) — there is no
inline script. Errors are an `Err(code, message)` thrown anywhere and caught once at the top.

### Actor resolution

- `Authorization: Bearer <x>` — if `x` starts with `sess-`, it's a session id; otherwise it's a
  token's API **secret**, looked up by `sha256(x)` against the token table. A token's **public id
  is never accepted** as a credential.
- The cookie `atomic_session` is a session id, identical to a `Bearer sess-…`.
- Anything else resolves to `atom://0` — the anonymous identity with no grants.
- A **session** is itself an atom binding a cookie to a token, parented into that token's tenant,
  7-day expiry, never served through the surface.
- **Magic-link:** `POST /auth { email }` mints a one-time code (15-minute expiry, held in memory);
  `GET /auth/verify?code=` exchanges it for a session cookie. With no mailer, the link is surfaced
  in the response (dev only — never in `prod`/`locked`).
- The literal `ATOMIC_ADMIN_SECRET` bearer additionally marks the actor `_admin` — the only
  identity that may activate break-glass.

### Validation

`validate(model, attr)` walks the model's declared fields: a field that is an embed recurses;
otherwise the value gets its `default`, a `required` check, then `checkKind` — `text` ·
`longtext` · `email` · `url` · `uuid` (format-checked) · `integer` · `number` (with `min`/`max`)
· `boolean` · `datetime` · `enum` (∈ `values`) · `ref` (must be `atom://…`) · `list` (an array) ·
`map` (an object) · `json` (anything) — plus `minLength`/`maxLength`/`pattern` on strings.
**Undeclared fields are dropped; list items are *not* recursed** (which is why an embedded `grant`
inside a `token.grants` list rides through unvalidated). A model write also rejects an unknown
`sensitivity` level.

### Grants, roles & attenuation

A token's **effective grants** are its own `grants` plus every referenced role's grants.

- `permits(mode, op)` — `all` permits everything; `read` is permitted only by `read` or `all`;
  `write` permits any *mutation* (create/update/delete) but **not** read; otherwise the mode must
  equal the op. `export` is its own mode, checked only by the export gate.
- `grantMatch(path, target)` — segment-wise over a dotted path: `*` matches exactly one segment,
  `**` matches any number (including zero). So `person.*` covers `person.email` but not
  `person.address.zip`; `**` covers everything.
- `allows(actor, target, op)` = some effective grant both `permits` the op and `grantMatch`es the
  target. `canOp` is the model-level form.
- **Attenuation:** on every `token`/`hook` write, each granted grant (inline *and* via a worn
  role) must be a subset of the issuer's own — you can never mint more authority than you hold.

### Tenancy & visibility

`lifecycle.parent` forms a tenant tree. `tenantOf(atom)` walks parents to the owning tenant;
`shardOf` is that tenant or `_global` for tenant-less atoms. `visible(actor, atom)` passes when
the atom is not retired, not expired, and either global, or in the actor's tenant subtree, or the
actor is a tenant-less root. **Writes** additionally require sharing the tenant ancestor and
passing the model's write rule. Reads and the secondary index are always scoped to
`['_global', <tenant>]`, so a query never even loads another tenant's atoms.

### The write path

- **create** — `guardDangerous` → baseline create grant → `validate` → resolve tenant/parent →
  (tokens) mint a high-entropy secret, store only its hash → `seed` → log `create`. Defining a
  `model` mints the creator full grants on the new type; a unique index dedups by identity.
- **update** (PATCH, merge) / **replace** (PUT, whole `attr`) via `writeAtom` — `visible` →
  evidence-immutability check → `guardDangerous` → per-field update grant → optimistic-concurrency
  `If-Match` (version must match) → `validate` (merged or replaced) → `attenuate` → writable
  (tenant + rule) → `bump` (version++, `updatedAt`, `updatedBy`) → log.
- **retire** (DELETE) — `guardDangerous` → delete grant → writable → then, inside one
  transaction: the **legal-hold check** and the `onDelete` cascade → set `status: retired` → log
  `delete`. Deletes are soft; nothing is physically removed.

Every mutation appends a `log` atom (and, in `locked` mode, links it into the hash chain).

### Referential integrity

`inboundRefs(target)` finds live atoms pointing at it through a **declared `inverse`** edge (so
the ledger's bookkeeping refs are never mistaken for edges). Each referring field's `onDelete`
decides: `restrict` → `409`; `cascade` → retire the referrer too (recursively, cycle-guarded);
`null` → clear the cell and re-validate (a `required` ref can't be nulled). All of it runs in the
retire transaction, so a half-applied cascade can't corrupt the graph.

### Indexed reads

`filterable`/`sortable` fields are projected into `idx (shard, model, field, value, id)` on every
write. `indexedRead` serves a query straight from the index **when** the store has a `page`
method (not in-memory), the sort field and every filter field are indexed, the full-text `q`
filter isn't used, and — under encryption — only equality filters are present (blind-hashed
values can't range or sort). Otherwise it returns `null` and the kernel falls back to a
tenant+model-scoped scan. The store pushes shard + model + filters + sort + cursor into SQL; the
kernel over-fetches ~3× to re-apply per-actor read rules the index can't see, then redacts.
Pagination is cursor-based on the sort field (`page: { cursor, limit }`).

### Expiration & retention

`lifecycle.expiration` → a `policy` atom → a set of `condition` atoms `{ field, op, value }`. An
op is `eq` · `ne` · `in` · `older` · `newer` (the last two compare a date field to a duration like
`3y`/`30d` before now). An atom is **expired when *all* of its policy's conditions hold**; a
policy with no conditions never expires (the default is "not updated in three years"). Expiration
only *hides* — `visible` filters expired atoms out of reads, but they're never mutated, so editing
one (which bumps `updatedAt`) brings it back. A **legal hold** (`heldBy`, by atom/tenant/model
scope) blocks retire unconditionally — it overrides break-glass and approved changes alike.

### Schema migration

A `model` carries a `version`; each atom records the `modelVersion` it was last written under. A
`migration` atom is a one-way step `from → to`: `rename` or `default` (from a `spec`) or `custom`
(a vetted `scripts/<run>.mjs`). `bringForward` applies the **contiguous** chain starting at the
atom's version on read (a gap stops the walk); `sweepModel`/`sweepAll` complete the rewrite when a
model or migration is written and to completion on boot, then persist and log `migrate`. In
`locked` mode a `custom` migration must be in `ATOMIC_MIGRATIONS` or it fails closed — and the
boot sweep tolerates that (it leaves the atom behind rather than crashing).

### The store port

The kernel↔store seam is a small interface — `get` · `has` · `set` · `delete` · `values` ·
`count` · `query({shards, model})` · `page({…cursor})` · `setIndex` · `indexCount` · `transact` ·
`advisoryLock`. Three drivers implement it (in-memory, SQLite, Postgres) over the **same two
tables**, `atom` and `idx`. Atom bodies are `serializeLine`d — JSON, or `enc:`-prefixed
AES-256-GCM under `ATOMIC_KEY` (the `id`/`shard`/`model` columns stay plaintext for routing).
`tx()` is a reentrant in-process lock that serializes top-level transactions and joins nested
ones; `transact` is the driver's `BEGIN/COMMIT` (a structuredClone snapshot for memory);
`advisoryLock(key)` is `pg_advisory_xact_lock(hashtext(key))` on Postgres and a no-op on the
single-writer drivers.

### Boot sequence

`loadAll()` (a durable store on disk) → `migrate()` (idempotently add any missing core atoms,
refresh changed core-model schemas, backfill new lifecycle fields, run schema migrations) — or
`bootstrap()` on a fresh store (seed the core atoms, log each as `genesis`). Then refresh the
admin token's secret from `ATOMIC_ADMIN_SECRET`, backfill the secondary index if empty, and — for
`--audit`/`--check`/`--export-*`/`--import-all`/`--new-base` — run that command and exit instead
of listening. `prod`/`locked` run `assertBootMode` first and **exit non-zero** on an unsafe config.

### Locked-mode enforcement

Each guard is a small check threaded into the existing paths, active only when `LOCKED`:

- **`canReveal`** — a `restricted` field is projected only when the actor holds an *exact*
  `model.field` read grant **and** the request's `purpose` resolves to a live `purpose` atom the
  grant authorizes (or an active break-glass covers it). Otherwise it's redacted everywhere
  (`redact`, `readField`, lists, CSV).
- **`noteReveal` / `flushEvidence`** — reveals accumulate per request, grouped by model, on the
  actor copy; the response seam writes **one** `sensitive-read` per model *before* the bytes flush.
  In `locked` a failed evidence write throws `503` and the data is withheld (fail-closed).
- **`gateExport`** — before a CSV is built, every confidential/restricted column the actor lacks
  an `export` grant for is blanked; the model's `exports` posture is enforced; a sensitive export
  records an `export-job`.
- **`guardDangerous`** — a direct `POST/PATCH/PUT/DELETE` to a governance model throws unless the
  write is an approved change-request apply (`viaApproval`) or the actor holds an active
  break-glass.
- **`grantsOf`** — in `locked` it drops every `**` grant unless `activeBreakGlass(actor)` restores
  it; a break-glass's grants then expand the effective set.
- **`appendEvidence`** — links each evidence atom `{ prev, hash: sha256(prev + canonical), seq }`
  into its shard's chain inside a transaction holding the shard's advisory lock, advancing the
  persisted `evhead-<shard>`. The canonical form excludes a change-request's mutable
  `status`/`applied`, so the proposal stays signed across its workflow.

### Audit & self-test

`--audit` is a structural fsck — every atom resolves to a model, every ref/parent resolves, every
atom conforms to its schema, every grant and ledger entry is well-formed — plus, over a `locked`
store, the per-shard **evidence-chain re-walk** (contiguous `seq`, linked `prev`, recomputed
`hash`, head-matches-tail) and an informational expired-but-held count. `--check` runs the `test`
atoms over a live ephemeral surface as each test's `as` token, asserting `status` + `condition`
atoms against the response.

---

## Configuration

Read from the environment, with `./.env` as a gitignored fallback.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port | `3040` |
| `ATOMIC_MODE` | `dev` (friendly local), `prod` (durable store + real auth required, boot fails closed otherwise), or `locked` (the full governance posture — see [Locked mode](#locked-mode)) | `dev` |
| `ATOMIC_HOOKS` | Locked mode: comma-separated `run` basenames a hook may execute; others skip + record evidence | unset → none run |
| `ATOMIC_MIGRATIONS` | Locked mode: comma-separated `run` basenames a custom migration may execute; others fail closed | unset → none run |
| `ATOMIC_STORE` | Directory for the durable SQLite store | unset → in-memory |
| `ATOMIC_DB` | Postgres connection URL → the Postgres driver (needs optional `pg`) | unset → SQLite/in-memory |
| `ATOMIC_KEY` | Encryption key (64-hex or passphrase) for AES-256-GCM at rest | unset → plaintext |
| `ATOMIC_ADMIN_SECRET` | A fixed API secret for the admin token, for CI / seeds | unset → admin is magic-link only |
| `SENDGRID_API_KEY` | Sends magic-link sign-in email | unset → dev fallback (link surfaced locally) |
| `ATOMIC_MAIL_FROM` | From-address for sign-in email | — |

---

## CLI

| Command | What it does |
|---------|--------------|
| `node atomic.mjs` | Run the kernel (`npm start`). |
| `node atomic.mjs --check` | Run the substrate's own `test` atoms (`npm run check`). |
| `node atomic.mjs --audit` | Structural governance check (`npm run audit`); exits non-zero on any finding. |
| `node atomic.mjs --new-base "<name>"` | Provision a base from the CLI and print its share URL. |
| `node atomic.mjs --export-base <tenant>` | Dump a base (a tenant and its atoms) as NDJSON — a base is one file. |
| `node atomic.mjs --export-all` / `--import-all` | Move every atom between drivers. In `locked` mode the export is AES-GCM sealed and records an `export-job` evidence atom; import re-validates every atom and refuses forged evidence. |

---

## Testing & governance

Verification lives at two levels, and the second is itself made of atoms:

- **`test.mjs`** — an independent, black-box HTTP suite (257 assertions) covering validation,
  grants, tenancy, hooks, transactions, embed shapes, the editable grid, migration, durability
  across restart, and security regressions.
- **`--check`** — the substrate's own acceptance suite, *as data*: a `test` atom is
  `{ as, method, path, body, expect }`, run over the live surface as its `as` token, asserting
  status plus `condition` atoms against the response. Core self-tests run on any store; a tenant
  can add `test` atoms for its own models. (`test.mjs`'s final assertion is that `--check`
  exits green.)
- **`--audit`** — a structural fsck: every atom resolves to a model, every reference resolves,
  every atom conforms to its schema, and every grant, ledger entry, and parent is well-formed.
  In `locked` mode it also re-walks each tenant's **evidence hash chain** — every evidence atom
  (`log`, `sensitive-read`, `export-job`, `change-request`, `approval`, `break-glass`) links to
  the previous by `sha256(prev + event)`, so a tampered, deleted, or inserted record is a
  finding. The chain is per-tenant (concurrent across tenants) with a persisted head, appended
  under a per-tenant lock so multiple writers on one database can't fork it.

`--audit` covers structural invariants; `--check` covers behavioural ones. Point either at a
real store with `ATOMIC_STORE` / `ATOMIC_DB`.

---

## Project layout

```
atomic.mjs   the entire kernel — store, validation, permissions, HTTP API, UI, CSV, migration
test.mjs     black-box HTTP test suite
seeds/       four demo tenants (seed-a…d) built on seed-lib.mjs
scripts/     vetted hook + migration handlers, loaded by basename
package.json scripts; no required dependencies
```

---

## Status

Atomic is pre-launch and experimental. It runs and is exercised by 257 HTTP test assertions, a
self-test suite, and a structural + evidence-chain audit — but interfaces may still change. The
[locked-mode](#locked-mode) governance layer is implemented and tested; until a deployment
actually sets `ATOMIC_MODE=locked`, treat Atomic as a kernel prototype, control-plane model, and
admin-UI generator rather than the direct system of record for high-sensitivity data.

---

## License

MIT

# Atomic

> One record shape for everything — data, schema, identity, permissions, queries, the
> audit log, even the UI. Each is an **atom**, and one kernel governs them all.

![node](https://img.shields.io/badge/node-%E2%89%A522.5-3f6df6)
![dependencies](https://img.shields.io/badge/dependencies-0%20required-brightgreen)
![kernel](https://img.shields.io/badge/kernel-single%20file-blue)
![tests](https://img.shields.io/badge/tests-256%20passing-brightgreen)
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
to keep in sync. The whole thing is `atomic.mjs`: about 2,900 lines, zero required
dependencies.

[Why](#why) · [Quick start](#quick-start) · [Concepts](#concepts) · [How it works](#how-it-works) · [HTTP API](#http-api) · [Identity & access](#identity--access) · [Lifecycle](#lifecycle) · [The generated UI](#the-generated-ui) · [Persistence](#persistence) · [Configuration](#configuration) · [CLI](#cli) · [Testing & governance](#testing--governance) · [Status](#status) · [License](#license)

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
npm test         # 256 black-box HTTP assertions
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
`restricted`; default `internal`). In `locked` mode a `restricted` field is revealed only by an
**exact** `model.field` read grant — a wildcard (`*`/`**`, even a superuser's `**`) does not
reveal it, so it redacts out of reads, lists, queries, path traversal, and CSV by default.
Revealing a `restricted` field in `locked` mode also requires the request to declare a
**purpose** the grant authorizes (`X-Atomic-Purpose` / `?purpose=`, naming a `purpose` atom);
an optional `reason` (`X-Atomic-Reason` / `?reason=`) is recorded as evidence but never
grants access. Outside `locked` mode `sensitivity` is recorded metadata and does not change
access.

### References: `atom://` vs `embed://`

- **`atom://x`** is an edge to a standalone, shareable atom. It is stored as a live link, and
  reads see `x`'s current values. Declaring an `inverse` on the field makes the backlink
  queryable.
- **`embed://x`** (equivalently `{ kind: "embed", of: "atom://x" }`) inlines another model's
  shape directly into this atom. The values live in the parent's `attr`, are validated against
  `x`, and carry no `id` or `lifecycle` of their own. The *same* shape can be reused under
  multiple fields — `home` and `work` can both be `embed://address`.

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
  `write` (the mutation superset — it does **not** imply read) · `all`. Paths are `model`,
  `model.field`, or wildcards (`*`, `**`).
- **Roles.** A `role` atom bundles reusable grants; a token's effective grants are its own plus
  its roles'. A token can only wear a role within its own grants (attenuation).
- **Tenancy is structural.** `lifecycle.parent` forms a tenant tree. You may write an atom only
  if you share its tenant ancestor (or you are a tenant-less root). Global atoms are
  world-readable and root-writable.
- **Per-field redaction.** A read returns only the fields the actor is granted; path reads
  honor scope, grants, and rules at every hop. Fields can carry a `sensitivity` level; in
  `locked` mode a `restricted` field is revealed only by an exact `model.field` read grant,
  never a wildcard, and only when the request declares a `purpose` that grant authorizes.
  Each such disclosure writes one bounded `sensitive-read` evidence atom (one per model per
  request, not per row); in `locked` mode the read is fail-closed — if the evidence can't be
  recorded, the restricted data is withheld.
- **Export is its own right.** Reading a field and exporting it are separate: in `locked` mode
  a confidential/restricted field leaves in a CSV only under an explicit `export`-mode grant
  (never `read`/`write`/`all`), the model's `exports` posture (`disabled` · `grant` ·
  `approval`) is enforced, and a sensitive export records an `export-job` evidence atom.
- **Governed change + break-glass.** In `locked` mode governance atoms (models, tokens, hooks,
  …) can't be edited directly — only through a `change-request` an approval applies (maker ≠
  approver) — and a `**` grant is inert unless an **active break-glass** restores it.
  Break-glass is admin-secret-only, reasoned, and expiring: while active it grants full access
  and records every sensitive read with its reason.
- **One-click bases.** `POST /base { name }` (or `node atomic.mjs --new-base "<name>"`)
  provisions a tenant and an open-login token in one transaction and returns a **share URL** —
  open it and you are one-clicked into that base as a full, tenant-confined session.

---

## Lifecycle

- **Hooks.** A `hook` is a capability atom `{ run, grants }` registered in an atom's (or a
  model's) `lifecycle.hooks`, keyed `create` / `update` / `delete`. It runs `scripts/<run>.mjs`
  under its *own* grants — the caller needs no invoke permission, and `run` is locked to a safe
  basename. (Example: `scripts/census-district.mjs` geocodes an address and links a
  congressional-district atom on write.)
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

## Configuration

Read from the environment, with `./.env` as a gitignored fallback.

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port | `3040` |
| `ATOMIC_MODE` | `dev` (friendly local), `prod` (durable store + real auth required), or `locked` (prod + `ATOMIC_KEY` required, governance atoms frozen to direct edits, bulk export sealed + evidenced) | `dev` |
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

- **`test.mjs`** — an independent, black-box HTTP suite (256 assertions) covering validation,
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

Atomic is pre-launch and experimental. It runs, and it is exercised by 256 HTTP test
assertions, a self-test suite, and a structural audit — but interfaces may still change.

---

## License

MIT

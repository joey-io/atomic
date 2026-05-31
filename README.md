# Atomic

> A data substrate where schema, data, identity, permissions, queries, and the UI are all the same shape — an **atom**.

![node](https://img.shields.io/badge/node-%E2%89%A522.5-3f6df6)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![kernel](https://img.shields.io/badge/kernel-single%20file-blue)
![tests](https://img.shields.io/badge/tests-133%20passing-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

Atomic is a dependency-free, single-file kernel for graph-relational data. Every record — a row of data, a type definition, a permission grant, a saved query, an audit-log entry, even a test — is one shape:

```json
{ "id": "...", "model": "atom://...", "manifest": "...", "attr": { }, "lifecycle": { } }
```

One kernel validates, stores, queries, permissions, and renders all of them. There is no separate ORM, API layer, query builder, or UI framework, and no generated code to keep in sync. The HTTP API and the web UI are both generated from the same atoms.

The whole kernel is `atomic.mjs` (~2,400 lines, no dependencies). Persistence is embedded SQLite via Node's built-in `node:sqlite` — still a single file, still no `node_modules`.

---

## Contents

[Features](#features) · [Quick start](#quick-start) · [Concepts](#concepts) · [HTTP API](#http-api) · [Identity & access](#identity--access) · [Lifecycle](#lifecycle-hooks-expiration-migration) · [The generated UI](#the-generated-ui) · [Persistence](#persistence) · [Configuration](#configuration) · [Scripts](#scripts) · [Testing & governance](#testing--governance) · [Project layout](#project-layout) · [Status](#status) · [License](#license)

---

## Features

- **One shape, one format.** Records, schema, identity, permissions, queries, migrations, the audit log, and tests are all atoms of plain JSON, addressed the same way (`atom://id`).
- **Schema as data.** A `model` atom defines a type's fields, validation, indexes, and rules. Validation is Zod-style: kinds, `required`, `unique`, enums, ranges, patterns, and semantic formats (`email`/`url`/`uuid`).
- **Reusable shapes.** `embed://<model>` inlines another model's fields as a first-class, reusable schema fragment — addressable, requireable, and flattened into dotted columns in CSV.
- **Typed edges.** `ref` fields are graph edges; declaring an `inverse` makes backlinks queryable. Dotted **paths** (`/<id>.field.edge…`) traverse the graph under the reader's permissions.
- **Permissions as data.** `grant` and `role` atoms; a token's effective grants are its own plus its roles'. Tenancy is structural (`lifecycle.parent`) — the tree decides who may write.
- **Index-backed reads.** Declare a field `filterable`/`sortable` and the kernel maintains a generic secondary index over it (plus built-in `createdAt`/`updatedAt`); filtering, range, sort, and pagination are then pushed entirely into SQL — a read never materializes the model's full set, so a filtered/sorted page over a 100M-row model stays milliseconds, scoped per tenant. (Above the store port: the index holds opaque `(model, field, value, id)` rows; the store never learns the schema. Under `ATOMIC_KEY`, values are blind-hashed — equality only, no range/sort.)
- **Transactions.** `POST /tx` applies a batch of writes all-or-nothing; any failure rolls the whole batch back.
- **Hooks.** Capability atoms that run a vetted server script on create/update/delete under their *own* grants.
- **Lazy lifecycle.** Non-destructive expiration (retention policies) and forward-only schema migration, both applied on read.
- **CSV import/export**, generated from the model, with an optional atomic (transactional) import.
- **Editable grid.** Every model table is inline-editable exactly where the viewer holds an update grant — single-field `PATCH` with optimistic concurrency.
- **Self-tests & governance.** `--check` runs the substrate's own acceptance tests (which are themselves atoms); `--audit` is a structural fsck.
- **Durable, ACID, optionally encrypted at rest** (AES-256-GCM) — or purely in-memory.
- **Hardened HTTP surface**: strict CSP, security headers, `HttpOnly`/`SameSite` session cookies, no email-enumeration oracle, size-capped bodies.

---

## Quick start

**Requirements:** Node ≥ 22.5 (for `node:sqlite`). Node ≥ 24 runs it unflagged; on 22.x the SQLite binding is behind an experimental flag (in-memory mode needs nothing).

```bash
# in-memory (nothing persists) — http://localhost:3040
npm start

# durable: point ATOMIC_STORE at a directory (creates <dir>/atoms.db, WAL mode)
ATOMIC_STORE=./data npm start

# run the test suite, the self-tests, and the governance audit
npm test         # 133 assertions over HTTP
npm run check    # the kernel's own test atoms
npm run audit    # structural invariants (exits non-zero on any finding)

# load four demo tenants (a PAC, an advocacy program, a hybrid, a household)
npm run seed
```

**Authentication.** A token's public id is never a credential. Humans sign in by magic-link (`POST /auth { email }` → a link → a session cookie; in dev with no mailer configured, the link is returned in the response). Integrations present a token's **API secret** as `Authorization: Bearer <secret>` — minted and shown **once** when the token is created. The admin can also be given a fixed secret via the `ATOMIC_ADMIN_SECRET` env var (used by `npm run seed` and CI); otherwise the admin is magic-link only.

---

## Concepts

Atomic has six primitives:

| Primitive | What it is |
|-----------|------------|
| **Atom**  | A record: `{ id, model, manifest, attr, lifecycle }`. |
| **Model** | An atom that defines a type — its fields, indexes, and rules. Validates an atom's `attr` on write. |
| **Index** | An atom describing a stored query or constraint over a model's atoms. |
| **Path**  | A dotted expression that reads across fields and edges. |
| **Logic** | A rule (path predicate) or a transform (a vetted handler / hook). |
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

- `id` — opaque, immutable. The reference route is `atom://id`.
- `model` — pointer to the model atom that defines this record's type.
- `manifest` — free-text label, full-text indexed.
- `attr` — the record's values; the model validates them. `ref` values are edges.
- `lifecycle` — kernel-managed: status, version (write count), `modelVersion`, `parent` (tenant), and created/updated actor + time.

### The model

A model is an atom whose `attr.fields` declares the type. The kernel's own types (`model`, `token`, `index`, `log`, …) are themselves model atoms.

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

**Field kinds:** `text`, `longtext`, `email`, `url`, `uuid`, `datetime`, `integer`, `number`, `boolean`, `enum` (`values`), `ref` (`to`, `inverse`), `list` (`of`), `map`, `json`, and `embed` (`of`). Common modifiers: `required`, `unique`, `default`, `min`/`max`, `minLength`/`maxLength`, `pattern`, enum `values`, and `filterable`/`sortable` (index the field — see Index-backed reads).

### References: `atom://` vs `embed://`

- **`atom://x`** — an edge to a standalone, shareable atom. Stored as a live link; reads see `x`'s current values.
- **`embed://x`** (or `{ kind: "embed", of: "atom://x", required: true }`) — inline another model's shape here. The values are stored in the parent's `attr` and validated against `x`; they carry no `id` or `lifecycle`. The *same* shape can be reused under multiple fields (`home` and `work` both `embed://address`).

---

## HTTP API

The surface is generated from the atoms. HTTP method maps to an operation, gated by the actor's grants:

| Method | Operation | Notes |
|--------|-----------|-------|
| `GET /<id>` | read | the atom (HTML with `Accept: text/html`, else JSON) |
| `GET /<model>` | list | the model's atoms; `field=v`, `field>=n`, `sort=-field`, `limit`, `cursor`, CSV (index-backed on declared fields) |
| `GET /<id>.<field>.<edge>…` | path read | traverse edges under the reader's permissions |
| `POST /<model>` | create | one atom, a JSON array (bulk), or a `text/csv` body (import) |
| `PATCH /<id>` | update | merge `attr`; honors `If-Match` (optimistic concurrency) |
| `PUT /<id>` | replace | replace `attr` wholesale |
| `DELETE /<id>` | retire | soft-delete (sets `status: retired`) |
| `POST /tx` | transaction | a JSON array of ops, applied all-or-nothing |

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

```bash
curl -X POST localhost:3040/tx -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' -d '[
    {"op":"create","model":"contact","id":"c2","attr":{"name":"A"}},
    {"op":"update","id":"c1","ifMatch":2,"attr":{"name":"B"}},
    {"op":"delete","id":"c-old"}
  ]'
# → { "ok": true, "results": [...] }   (or the whole batch rolls back on any failure)
```

### CSV

Every model table and index result has an **export** (`?as=csv`) and a **template** (`?as=template`); embedded shapes flatten into dotted columns (`address.street`). Import is a `POST` of a `text/csv` body (or JSON array); add `?atomic=1` to make the whole import one transaction.

---

## Identity & access

- **Tokens.** A `token` atom is an identity carrying `grants` (and/or `roles`). A token's public **id is never a credential** (ids leak through `createdBy`, refs, and path reads). Each token instead holds a high-entropy **API secret**, stored only as a hash and surfaced once at creation; present it as `Authorization: Bearer <secret>`. A session id works as a bearer too (`Bearer sess-…`), identical to the cookie.
- **Grants.** `{ path, mode }` where mode is `read` · `create` · `update` · `delete` · `write` (the mutation superset — does **not** imply read) · `all`. Paths are `model`, `model.field`, or wildcards (`*`, `**`).
- **Roles.** A `role` atom bundles reusable grants; a token's effective grants are its own plus its roles'. A token can only wear a role within its own grants (attenuation).
- **Tenancy is structural.** `lifecycle.parent` forms the tenant tree. You may write an atom only if you share its tenant ancestor (or you are a tenant-less root). Global atoms (`parent atom://0`) are world-readable and root-writable.
- **Per-field redaction.** A read returns only the fields the actor is granted; path reads honor scope, grants, and rules at every hop.
- **Sign-in.** Magic-link via email (`POST /auth { email }` → link → session cookie), plus one-click **open-login** tokens (`login: open`) for public intake. Sessions are bearer credentials, never served through the read surface.

---

## Lifecycle: hooks, expiration, migration

- **Hooks** — a `hook` is a capability atom `{ run, grants }` registered in an atom's (or model's) `lifecycle.hooks`, keyed `create`/`update`/`delete`. It runs `scripts/<run>.mjs` under its *own* grants (the caller needs no invoke permission). `run` is locked to a safe basename. Example: `scripts/census-district.mjs` geocodes an address and links a congressional-district atom.
- **Expiration** — `lifecycle.expiration` points at a `policy` (a set of `condition` atoms). An atom is expired when all its policy's conditions hold; expired atoms are filtered out of reads, never mutated (editing brings them back). Default policy: not updated in 3 years.
- **Schema migration** — each model carries a `version`; each atom records the `modelVersion` it was written under. A `migration` atom is a one-way step (`rename`/`default` from `spec`, or a vetted `custom` handler). Behind atoms are brought forward on read, on schema change, and to completion on boot — then persisted and logged.

---

## The generated UI

Browsing any atom with `Accept: text/html` renders a generated interface from the same atoms: recursive atom rendering, sortable tables, model-driven create/edit forms (embed → nested table, list → repeater, ref → autocomplete), index forms, and a backlink ref-map. The stylesheet uses no classes and no ids — every rule targets a semantic element.

**Editable grid.** Every model table is inline-editable exactly where the viewer holds an update grant: text/number cells are `contenteditable`, enums become `<select>`, booleans a checkbox (refs/embeds/lists edit via the row form). An edit is a single-field `PATCH` with `If-Match`, so per-field grants and optimistic concurrency apply automatically — an unauthorized cell isn't editable, a stale version reloads the row. The client is one static, same-origin `/app.js` (no inline script, strict CSP).

---

## Persistence

- **In-memory** by default (nothing persists).
- **Durable** when `ATOMIC_STORE=<dir>` is set: state lives in `<dir>/atoms.db` (WAL-mode SQLite, one `atom` table indexed on `shard` and `model`). State is authoritative in the table — there is no boot-time log replay, and reads are scoped to a tenant + type in SQL, so a read never materializes another tenant's atoms.
- **Encrypted at rest** when `ATOMIC_KEY` is set (64-hex or a passphrase stretched with scrypt): each atom's `body` is sealed with AES-256-GCM (confidential and tamper-evident); the structural columns `id`/`shard`/`model` stay plaintext for routing and indexing.

SQLite is the storage port, not the model — no SQL, ORM, or query builder reaches the user-facing surface.

---

## Configuration

Read from the environment, with `./.env` as a fallback (gitignored).

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port | `3040` |
| `ATOMIC_STORE` | Directory for the durable SQLite store | unset → in-memory |
| `ATOMIC_KEY` | Encryption key (64-hex or passphrase) for AES-256-GCM at rest | unset → plaintext |
| `ATOMIC_ADMIN_SECRET` | A fixed API secret for the admin token (`Bearer <it>`), for CI / seeds | unset → admin is magic-link only |
| `SENDGRID_API_KEY` | Sends magic-link sign-in email | unset → dev fallback (link surfaced locally) |
| `ATOMIC_MAIL_FROM` | From-address for sign-in email | — |

---

## Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Run the kernel (`node atomic.mjs`). |
| `npm test` | Full HTTP smoke test — 133 assertions, boots a temp instance, restarts to prove durability. |
| `npm run check` | Run the substrate's own `test` atoms (`node atomic.mjs --check`). |
| `npm run audit` | Structural governance check (`node atomic.mjs --audit`); exits non-zero on any finding. |
| `npm run seed` | Load four demo tenants over the API. |

---

## Testing & governance

Verification lives at two levels:

- **`test.mjs`** — an independent, black-box HTTP suite (133 assertions): validation, grants, tenancy, hooks, transactions, embed shapes, the editable grid, migration, durability across restart, and security regressions.
- **`--check`** — the substrate's own acceptance suite, **as data**: a `test` atom is `{ as, method, path, body, expect }`, run over the live surface as its `as` token, asserting status plus `condition` atoms against the response. Baked-in core self-tests run on any store; a tenant can add `test` atoms for its own models. `test.mjs`'s final assertion is that `--check` itself exits green.
- **`--audit`** — a structural fsck: every atom resolves to a model, every reference resolves, every atom conforms to its schema, every grant/ledger entry/parent is well-formed.

`--audit` covers structural invariants; `--check` covers behavioural ones. Point either at a real store with `ATOMIC_STORE` / `ATOMIC_KEY`.

---

## Project layout

```
atomic.mjs        the entire kernel — store, validation, permissions, HTTP API, UI, CSV, migration
test.mjs          black-box HTTP test suite
seeds/            four demo tenants (seed-a…d) built on seed-lib.mjs
scripts/          vetted hook + migration handlers (census-district, …) loaded by basename
package.json      scripts; no dependencies
```

---

## Status

A runnable kernel, exercised by 133 test assertions and a structural audit. Pre-launch and experimental.

**Built:** atoms · models & validation · `embed://` reusable shapes · refs + inverse edges · paths · grants/roles · structural tenancy · transactions (`/tx`) · hooks · lazy expiration · lazy schema migration · CSV import/export · editable grid · **secondary `attr`-field index** · tests-as-atoms (`--check`) · governance audit (`--audit`) · durable/encrypted SQLite · hardened HTTP surface.

**Not yet built:**

- **Write-time referential integrity / `onDelete`.** Deleting an atom does not yet cascade, restrict, or null inbound edges (dangling refs render as plain text and are flagged by `--audit`).
- **One-click tenant packaging.** The parts exist (structural tenancy, open-login tokens, file-driven seeds); a "one base = one tenant, one URL" wrapper does not.

---

## License

MIT

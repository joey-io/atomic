# Atomic

Atomic stores data and its definitions as one kind of record. A model defines a type. Its API, queries, permissions, and rendering come from that definition. There is no separate ORM, API layer, or UI configuration.

Atomic is a data substrate for graph-relational, queryable stores such as a CRM. Every record is an atom. The schema that defines other records is also made of atoms. Relationships are typed edges. Queries, constraints, permissions, and migrations are atoms and run by one kernel.

**Why one shape.** Atomic is built to be legible — to people and to machines. The whole system is one idea (the atom) and one format (JSON): there is no ORM, API layer, query builder, or UI framework to hold in your head, and no generated code to keep in sync. A complex data system stays simple to reason about because every part — a record, a type, a permission, a query, a migration, an audit entry — is the same shape, addressed the same way. The model is depth-on-demand: light when you don't need it, deep when you do. And because the substrate is plain JSON at its core, an AI agent — including small or local models — can read, build, maintain, and support it without special tooling. The simplicity is the feature: fewer moving parts is fewer things an agent (or a person) can get wrong.

## Status — running instance and roadmap

A runnable kernel lives in `atomic.mjs` (dependency-free, **Node ≥ 22.5** for `node:sqlite`; ≥ 24 to run it unflagged — the live instance is pinned to Node 24). It is deployed live at **`http://165.22.37.30:3040/`** under pm2 (process `atomic`), with durable persistence in embedded **SQLite** under `ATOMIC_STORE` (via `node:sqlite` — part of the Node runtime, still no dependency). Configuration is in `.env` (gitignored): `SENDGRID_API_KEY` (magic-link email, reused from MondayDraft), `ATOMIC_MAIL_FROM`, `ATOMIC_STORE`, `PORT`. The US Census geocoder used by the demo hook is keyless — no API key needed.

**What works today (all exercised by `node test.mjs`, 118 assertions — the last of which runs the kernel's own `--check` self-tests):**

- Atoms, models, Zod-style validation (semantic kinds `email`/`url`/`uuid`, refinements), `embed://` inline shapes, refs + inverse edges, path traversal with a budget.
- One read seam (`getStore(actor)`); per-attribute redaction; rules predicates; identity dedup/merge; optimistic concurrency; retire (soft delete).
- Grants with `read`/`create`/`update`/`delete`/`write`/`all` modes — `write` is the mutation superset and does **not** imply read; `all` is everything. HTTP method → op.
- **Roles** — a `role` atom is a reusable bundle of grants; a token references roles via `attr.roles`, and its effective grants are its own plus its roles'.
- Tenancy = `lifecycle.parent`; global atoms (parent `atom://0`) are world-visible; a tenant-less token is a superuser.
- **The tree decides writes.** You may write an atom only if you share its tenant ancestor (or you're a tenant-less root): `writable(actor, atom) = (root ∨ atom.tenant == actor.tenant) ∧ rules.write`. So global/root atoms — the core substrate and shared definitions — are writable **only by root**, structurally, for every type; a tenant user writes only within its own tenant; root writes anything.
- **Self-service within a tenant — everything is atom CRUD.** Inside its own tenant a user can do anything the substrate can, under a grant: define new **types** (`model`) — *creator-owns* mints `<type>.*` on the definer so a freshly-defined type is immediately usable; save **reports** (`index`); author **retention** (`condition`/`policy`, pointed at via `lifecycle.expiration`); and **wire** vetted automations (`hook`, attenuated, with `run` locked to a safe basename). The *one* operator-only act is **authoring a hook's script** — server code with raw store access. Everything else, including defining types and access, is just atom CRUD.
- Identity: token atoms, `atom://joey` (root `**`/`all`), `atom://0` (anonymous, no grants). Magic-link sign-in via SendGrid + session atoms + cookie; **open-login** tokens (`login: open`) for one-click public access.
- **Hooks registered in `lifecycle.hooks`** of any atom (keyed `create`/`update`/`delete`). A hook is a capability atom `{ run, grants }` that runs under **its own** grants — the caller needs no invoke permission. Put a hook on a model atom and it fires for every instance. The reference hook (`scripts/census-district.mjs`) geocodes an advocate's address against the US Census and upserts + links a congressional-district (`census`) atom.
- Generated surface: API + UI from the same atoms; recursive atom rendering; sortable/overflow tables; model-driven create forms (embed → nested table, list → repeater, ref → autocomplete); index forms; backlink ref-map. Links render **only** to atoms the viewer can actually open — a ref to a missing, retired, or unreadable atom shows as plain `atom://id` text.
- **The grid is editable — click a cell, type, Tab to the next.** Every model table renders its scalar cells inline-editable **exactly where the actor may update that field** (text/number → `contenteditable`, enum → a `<select>`, boolean → a checkbox; `ref`/`embed`/`list`/`json` stay read-only — edit those through the row's form). An edit is a single-field `PATCH /<id>` with `If-Match` — so per-field grants and optimistic concurrency already hold: a cell the actor can't write isn't editable, a stale version is a `409` and the row reloads, a rejected value reverts. No new endpoint and no inline script (the cells carry `data-id`/`data-field`/`data-ver`; the strict CSP's same-origin `/app.js` wires blur/Enter → PATCH). It is the spreadsheet feel — "what is editable here" rendered straight from the model and the viewer's grants.
- Styling: Noto Sans (Google Fonts) and one small variable-driven stylesheet (inlined, served at `/style.css`) with **no classes and no ids** — every rule targets a semantic element. Structure carries meaning: a data grid is a `<table>` with a `<thead>` inside a scrolling `<figure>`; a key/value or form table is a bare `<table>`; a repeater is a `<fieldset>`. (The single exception is `<datalist id>` ↔ `<input list>`, the spec's only way to bind ref-autocomplete — a functional binding like `name`, not a style hook.)
- Four demo tenants seeded from files (not baked into the kernel): **A** = a PAC (`seeds/seed-a.mjs` — 3 regions, 20 people in a `manager` reporting chain, 100 fundraising txns), **B** = an advocacy program (`seeds/seed-b.mjs` — officials, districts, advocates with real addresses, stories; CapConnect = open-login write-only intake wearing the `website` role), **C** = a hybrid (`seeds/seed-c.mjs`), **D** = a household (`seeds/seed-d.mjs` — a 3-bedroom house with rooms, belongings, and residents as first-class queryable edges; Billy defines his own household types and gets an open-login token). Admin is `joey@emailjoey.com`. The census hook is verified live: Baltimore → MD-07, Chicago → IL-07, Dallas → TX-30.
- **Durable, indexed, ACID persistence in embedded SQLite, with opt-in encryption at rest.** Set `ATOMIC_STORE` and state lives in a WAL-mode `atoms.db` (one `atom` table: `id, shard, model, body`, indexed on `shard` and `model`). State is **authoritative in the table, not the fold of a log** — so there is no boot-time replay and the working set need not fit in RAM; boot is O(1). Reads are scoped to a tenant (`shard`) and type (`model`) in SQL, hitting the indexes — a read never materializes another tenant's atoms (the lever that holds up at billions of atoms/tenant). A legacy NDJSON store migrates itself into `atoms.db` on first boot (last-write-wins, old logs set aside as `.migrated`). Set `ATOMIC_KEY` (64-hex, or a passphrase stretched with scrypt) and each atom's `body` is sealed with AES-256-GCM — confidential and tamper-evident (a wrong or altered key fails the load closed); the structural columns `id/shard/model` stay plaintext so the engine can route and index on them. Unset `ATOMIC_STORE` runs purely in-memory (the default). The `node:sqlite` engine and on-disk format are stable; the binding API is flagged experimental on Node 22 (unflagged on Node 24+). **SQLite is the storage port, not the model:** the kernel still exposes only atoms and JSON — no SQL, ORM, or query builder reaches the user-facing surface — so "one shape, one format" holds; the SQL lives entirely inside the seam, the way `fs` did before it.
- **Hardened HTTP surface.** Every response sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`; HTML adds a strict Content-Security-Policy (`script-src 'self'` — the client is one static, same-origin `/app.js` — its source lives in `atomic.mjs` as a function, served as its own source — with no inline script anywhere). Session cookies are `HttpOnly; SameSite=Lax`, add `Secure` behind TLS, and carry full-entropy ids; `/auth` answers identically for known and unknown emails (no enumeration oracle). A session is a bearer credential, never application data: session atoms are parented into their token's tenant and are **never served through the read surface** — no listing, index, universal feed, ref-map, or direct id read can ever return a live cookie, even to an admin. A bearer or session credential only resolves if it points at a live (non-retired, non-expired) `token` atom — retiring a token revokes it immediately, on both the Bearer and the session path. **Path reads are gated like the whole-atom view:** a dotted path (`/<id>.<field>.<edge>…`) honors tenant scope, the per-attribute read grant, and `rules` at the head atom and at every ref hop — so a path can never reach an atom or field the actor couldn't read directly, nor leak another token's grants/email or a backlink it can't see. Request bodies are size-capped (JSON, form, and CSV), so an oversized upload is rejected with `413` rather than buffered to exhaustion, and an explicit `id` must be a safe slug (no HTML/URL metacharacters). Global **system tokens are superuser-only**: a tenant-less `token` atom (the root admin) is not world-visible the way the core models and shared reference atoms are, so it can never be read by a tenant user — even one holding a `token` read grant — only by another superuser. (`atom://0`, the public app descriptor, is the sole exception.)
- **CSV import / export, generated from the model.** Every model table and index result has an **export CSV** link (`?as=csv`; respects read grants and redaction), every model offers a **download template** (`?as=template` — header row of `id, manifest, <fields>`, with an embedded shape flattened into dotted columns like `address.street`), and the generated form's method picker gains an **IMPORT** option that reveals a drag-and-drop dropzone. Import is not a new verb: a `POST` to a model with a `text/csv` body (or a JSON array) is a bulk create — each row runs through the normal `create()` path (grants, attenuation, rules, dedup, hooks) and the response is a per-row `{ imported, failed }` summary. Add `?atomic=1` to make the whole import one transaction (see below): a single bad row rolls every row back and returns the error, rather than a partial load.
- **Transactions — all-or-nothing batch writes (`POST /tx`).** A `POST` to `/tx` with a JSON array of operations applies them as one unit. Each op mirrors a REST verb — `{op:'create', model, attr, …}`, `{op:'update'|'replace', id, attr, ifMatch}`, `{op:'delete', id}` — and is dispatched through the *same* mutator the verb uses, so grants, attenuation, rules, tenant scope, identity dedup, and optimistic concurrency (`ifMatch`) all apply per op, unchanged. The batch runs inside one store transaction: if any op throws (a validation error, a `403`, a version `409`), the **whole batch rolls back** and the response carries the failure — nothing is half-applied, and a rolled-back id is free again (no half-create in the data *or* the ledger). On success the response is `{ ok, results }`. Lifecycle hooks and migration sweeps run **after** the batch commits, never inside it — a hook may call an external service, and an external side-effect cannot be rolled back. The transaction is the store's own: durable SQLite `BEGIN`/`COMMIT` under `ATOMIC_STORE`, a deep in-RAM snapshot for the default memory store. This is **not a new primitive** — `/tx` is a batch envelope over the existing CRUD verbs, the same way IMPORT is `POST`-many; the store learns "a boundary," not a schema. Transactions are the substrate's defense against a fat-fingered bulk edit or a half-succeeding import corrupting a base.
- **Governance self-check** — `npm run audit` (`node atomic.mjs --audit`): a fsck for the substrate that asserts its own invariants (every atom resolves to a model, every reference resolves, every atom conforms to its schema, every grant is well-formed, every ledger entry is well-formed, every parent resolves) and exits non-zero on any finding, so it slots into CI or a cron. Point it at a real store with `ATOMIC_STORE`/`ATOMIC_KEY`.
- **Tests are atoms — the substrate carries its own acceptance suite.** A `test` is a core model (`{ as, method, path, body, expect }`); `npm run check` (`node atomic.mjs --check`) runs every `test` atom over the live HTTP surface **as its `as` token**, and checks the response `status` plus any `condition` atoms — the same predicate atoms the expiration system uses, **reused as the assertion language** — against the response body (a dotted `field` reads `id` / `manifest` / `attr.x.y` / `lifecycle.*`). The kernel ships baked-in core self-tests (root readable, anon blocked, models listable, the suite is itself visible, unknown → 404) that run on **any** store with no fixtures; a tenant can add `test` atoms for its own models the same way — they're listable, editable, exportable, and in the ledger like any atom. This is the `--audit` idea extended from structure to behaviour: read-only and negative (non-2xx) tests don't mutate, so `--check` is idempotent and re-runnable in CI. The audit covers *structural* invariants; `--check` covers *behavioural* ones. A thin external `test.mjs` remains for what a self-hosted suite structurally can't do — boot/restart durability, and an independent black-box net that doesn't share fate with a kernel bug (its final assertion is that `--check` itself exits green).
- **Schema migration, applied lazily.** Each model carries a `version`; every atom records the `modelVersion` it was written under. A `migration` atom is a one-way step from `from` to `to`: `rename` and `default` are applied by the kernel from `spec`, `custom` runs a vetted `scripts/<run>.mjs` handler (the same basename-locked safety as hooks). When an atom is behind its model, the kernel applies the contiguous chain in order, returns the current shape, and rewrites the record forward — persisted and logged as a `migrate` ledger entry. The sweep runs on read of a single record, on every schema change (a model write or a new migration), and to completion on boot (the "background job"). An atom already at the current version is a single integer comparison and a no-op.

**Open threads / deliberate boundaries:**

- **`attr`-field indexing — the real unbuilt gap.** Only the two *structural* columns are indexed: `shard` (tenant) and `model` (type). A filter or sort on a value *inside* a record — `state = 'CA'`, `amount > 1000` — is **not** index-backed: it scans the tenant- and model-scoped set in JS, O(n) within that set. **Stored indexes do not change this** — a stored index's `match`/`sort` runs over the same scoped set, so unless its key is one of the two structural columns, naming the query doesn't make it use an index (a named scan is still a scan). Making intra-record filters index-backed needs a real secondary index over chosen `attr` fields, and that is genuinely not built.
  Two honest constraints on building it:
  - *It must stay above the store port.* SQL generated columns / model-aware tables would make the substrate learn the schema — that's Fork B in [WHATIF.md](WHATIF.md), the line the design says never to cross. The thesis-consistent form is a **generic** secondary table the *kernel* populates from each model's `filterable`/`sortable` declarations: the store holds opaque `(model, field, value)` rows and still never learns what a `contact` is. That's Fork-A-compatible and is the form worth building.
  - *Encryption narrows it, per field, not all-or-nothing.* The naive `json_extract(body, …)` generated column can't work under `ATOMIC_KEY` at all (the body is ciphertext). The secondary-table form resolves that but forces a per-field choice: index-backed **equality** survives encryption via a keyed blind index (store an HMAC of the value — confidential, exact-match only); index-backed **range/sort** does not, short of an order-preserving scheme that leaks order — the hard problem every encrypted store hits. The default **unencrypted** store (the live instance sets no `ATOMIC_KEY`) has neither limit: there a secondary table gives equality, range, and sort directly. So: unbuilt; straightforward over a plaintext store; equality-only under encryption.
- Nashville (`1 Public Sq`, TN) was the one demo address the US Census geocoder didn't match (11 of 12 districts resolved) — a data quirk in the upstream geocoder, not the kernel.

## Primitives

Atomic has six concepts:

1. **Atom** — a record: `{ id, model, manifest, attr, lifecycle }`.
1. **Model** — defines a type's fields, indexes, and rules. It validates an atom's `attr` on write.
1. **Index** — a stored query or constraint over a model's atoms.
1. **Path** — a dotted expression that reads across fields and edges.
1. **Logic** — a rule or transform, written as a path expression or a handler.
1. **Log** — an append-only record of every change.

## Atom

An atom is a raw data record. Every atom has the same five fields.

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
    "updatedAt": "2026-05-28T15:20:00Z",
    "updatedBy": "atom://tok-amy"
  }
}
```

|Field      |Definition                                                                                            |
|-----------|------------------------------------------------------------------------------------------------------|
|`id`       |Unique, opaque, immutable identifier. The reference route is `atom://id`.                              |
|`model`    |A pointer to the model atom that defines this record's type. This pointer is the record's identity.   |
|`manifest` |Free-text description. Set through CRUD. Full-text indexed.                                            |
|`attr`     |The record's values. The model validates them. `ref` values are edges.                                |
|`lifecycle`|Kernel-managed: `status`, `version` (write count), `modelVersion`, `parent` (the containing atom — see Tenant), and created/updated actor and time.|

`id` is opaque and never changes. References stay valid when data changes. Domain timestamps such as `closedAt` go in `attr`. `lifecycle` holds operational metadata only.

`createdBy` and `updatedBy` are the tokens that wrote the atom — the actors defined in Identity and access. When `lifecycle` is written as a bare reference such as `"lifecycle": "atom://0"`, it is shorthand: the atom was created by that token — here `atom://0`, the root — and carries default operational metadata. The kernel models use this shorthand because `atom://0` created them.

## Model

A model is an atom that defines a type. It lists the type's fields, indexes, and rules. The kernel's own types are themselves model atoms, listed under Kernel atoms below.

An atom names its model with the `model` pointer. The kernel uses that pointer to decide which rules, indexes, and migrations apply. On every write, the kernel validates the atom's `attr` against the model's `fields`. Validation is schema validation: it checks field kinds, `required`, `unique`, enum values, and defaults. A model is a Zod schema in this sense. The pointer answers "what type is this atom"; the schema answers "is this atom valid."

```json
{
  "id": "model",
  "model": "atom://model",
  "manifest": "Defines a type",
  "attr": {
    "label": "Model",
    "version": 1,
    "fields": {
      "label": {
        "kind": "text"
      },
      "version": {
        "kind": "integer",
        "default": 1
      },
      "fields": {
        "kind": "map",
        "required": true
      },
      "indexes": {
        "kind": "map"
      },
      "rules": {
        "kind": "json"
      },
      "display": {
        "kind": "json"
      },
      "behavior": {
        "kind": "json"
      }
    },
    "indexes": {
      "byId": {
        "on": [
          "id"
        ],
        "role": "identity"
      }
    },
    "behavior": {
      "mutable": true,
      "merge": "replace",
      "addressing": "surrogate"
    }
  },
  "lifecycle": "atom://0"
}
```

**Field kinds**

- Scalars: `text`, `longtext`, `integer`, `number`, `boolean`, `datetime`, `enum`.
- Semantic strings: `email`, `url`, `uuid` — validated by format, like Zod's `z.string().email()`.
- `ref`: a reference to a standalone atom. Declares `to` (target model) and optional `inverse`. Stored as a link to a separate record.
- Containers: `list` (item type declared with `of`, e.g. `of: embed://grant`); `map` (a JSON **object**); and `json` (**any** JSON value — scalar, array, or object — for open-ended shapes like `rules`, `display`, or a condition's `value`, which may be a duration string, a scalar, or a list).
- Modifiers: `required`, `default`, `unique`, `filterable`, `sortable`; refinements `min`/`max` (numbers), `minLength`/`maxLength`/`pattern` (text).

## Kernel atoms

The system is made of atoms. The kernel's own types are model atoms, so the kernel runs on the same machinery as the data it stores. These are the models that make the system work:

|Model      |What it is                                                                 |
|-----------|---------------------------------------------------------------------------|
|`model`    |Defines a type: its fields, indexes, and rules. Validates atoms of that type.|
|`index`    |A stored query or constraint over a model's atoms.                         |
|`migration`|A one-way transform that moves a model from one version to the next.       |
|`token`    |Identity and capability: an atom with grants over models and indexes, optionally an email for sign-in. A user is a token.|
|`tenant`   |An organization and isolation boundary. A token belongs to a tenant; the tenant's tokens are its members.|
|`session`  |Binds a signed-in browser (a cookie) to the token it authenticates — an atom like any other.|
|`log`      |An append-only entry recording one change to one atom. The ledger.         |
|`file`     |A stored blob, addressed like any atom.                                    |
|`config`   |Kernel and tenant settings.                                                |
|`plugin`   |A bundle of models, indexes, and handlers installed together.              |
|`hook`     |A handler that runs on a write — the transform side of Logic.              |

There is no `user` type. A user is a token — an atom with grants. `atom://joey` is the root authority (it holds `**`); `atom://0` is the genesis atom and the anonymous identity, the origin of the core models. Everything else — companies, contacts, deals, signups — is an application model built the same way. There is no privileged layer: defining a type, granting access, recording a change, and storing a record are all atom CRUD.

## References

A model's field definitions use two reference schemes:

- **`atom://x`** — an edge to a standalone atom `x`. Stored as a live link. Reads see `x`'s current values.
- **`embed://x`** — inline the fields of model `x` here. Resolved when the schema compiles. The values are stored in the parent record's `attr` and validated against `x`. They carry no `id` or `lifecycle`. Two spellings: the string shorthand `"embed://x"`, or the object form `{ "kind": "embed", "of": "atom://x", "required": true }` when you need to mark the embedded shape **required** — a required embed must be present on write, and its own `required` fields propagate inward (validation recurses into the shape).

`embed://` appears only in model definitions, never in stored records. A record holds resolved values, not the `embed://` string. Any model can be embedded by referencing it with `embed://`. The same model can also be used as a standalone atom elsewhere via `atom://`. **The same shape can be reused under more than one field** — `home` and `mailing` can both `embed://address` — making a model a reusable schema fragment without giving up legibility: the field stays a leaf, the shape stays one definition. (See `seeds/seed-lib.mjs`: `advocate` embeds `address` twice.)

Use `atom://` when the target is a record that exists on its own and may be shared (a company, a deal). Use `embed://` for a field group that belongs to one parent and is not shared (an address). In CSV, an embedded shape is **first-class, not an opaque blob**: it flattens into dotted columns — `address.street, address.city, …` — in the export, the import template, and on import (a dotted header rebuilds the nested object), so a reusable shape round-trips through a spreadsheet.

```json
{
  "id": "address",
  "model": "atom://model",
  "manifest": "Address fields, embedded by reference",
  "attr": {
    "label": "Address",
    "fields": {
      "street": {
        "kind": "text"
      },
      "city": {
        "kind": "text",
        "filterable": true
      },
      "state": {
        "kind": "text",
        "filterable": true
      },
      "zip": {
        "kind": "text"
      },
      "country": {
        "kind": "text",
        "default": "US"
      }
    }
  },
  "lifecycle": "atom://0"
}
```

## Graph

An `atom://` field is an edge. With `inverse` set, the kernel maintains the reverse edge automatically. Both directions are queryable. A path is a dotted expression that reads across edges and nested values:

```
deal.company.owner.team
```

Paths are used in filters, indexes, rules, and exports. Traversal follows these rules:

- References may form cycles. Traversal tracks visited atoms and stops when it revisits one. There is no fixed depth limit.
- Each traversal runs under a budget (time, atoms visited, result size). Callers may raise the budget.
- A reference to a missing atom is an error, not a null.
- Resolved references are cached and invalidated when the target changes.

A path segment may be a wildcard. `*` matches any one field or edge step. `**` matches any number of steps. A wildcard over a list or an inverse edge fans out to every target. Wildcards work anywhere paths are used, including filters, indexes, rules, and grants.

## Index

An index is a stored query or constraint over a model's atoms. It declares `over`, `params`, `match`, `sort`, `returns`, and a `role`:

- `filter` / `sort`: a parameterized query.
- `unique`: rejects a write that would duplicate the key.
- `identity`: a unique key used to detect duplicates on create.
- `inverse`: the reverse side of an `atom://` edge, exposed as a field on the target.

The `unique` and `inverse` field modifiers are shorthand for indexes. An index runs when referenced with parameters:

```
atom://openDeals?company=atom://northwind
```

```json
{
  "id": "openDeals",
  "model": "atom://index",
  "manifest": "Open deals for a company",
  "attr": {
    "label": "Open deals",
    "over": "atom://deal",
    "params": {
      "company": {
        "kind": "ref",
        "to": "atom://company"
      }
    },
    "match": {
      "company": "params.company",
      "stage": {
        "in": [
          "lead",
          "qualified"
        ]
      }
    },
    "sort": [
      {
        "amount": "desc"
      }
    ],
    "returns": "set"
  },
  "lifecycle": "atom://0"
}
```

An index may range over every atom with `over: atom://atom` — the universal type — and `sort` may name a `lifecycle` field such as `createdAt`. An index that declares `page: { cursor, limit }` is paginated with `?before=<cursor>&limit=<n>`. Two kernel indexes use this: `atom.byDate` (`over: atom://atom`, `sort: [{ createdAt: desc }]`, paginated) is the cross-model activity feed, and `log.byAtom` (`over: atom://log`, `match: { atom: params.atom }`) is one atom's full history.

## Rendering

A client renders an atom from its model's field kinds. Each kind has a default rendering: `text` is a text cell, `enum` is a fixed set of values, `ref` is a link to another atom, `datetime` is a date, `boolean` is a toggle. No extra definition is needed to render or edit any atom.

A model may add an optional `display` attr to curate the default: which fields appear, in what order, and how they group. `row` curates tables, `detail` curates a single record, `board` groups records into columns. `display` is a hint. When it is absent, the client renders from field kinds. A dashboard is a set of saved indexes plus optional display hints.

## Surface

The kernel exposes one address space. Every atom, model, and index is reachable by its `atom://` reference. A reference is both an API endpoint and a UI route. The kernel returns the same resource as data or as a rendered view, depending on the request.

- `atom://<id>` — a single record. As data, the atom JSON. As UI, its detail view, rendered from the model's field kinds.
- `atom://<model>` — a model. As data, the model definition. As UI, a table of every atom of that model, with an add form generated from the model's fields.
- `atom://<index>?<params>` — runs the index. As data, the result set. As UI, a table or board of the matching atoms.
- `atom://atom` — the universal type: every atom, newest first. `atom://0` (the root) is the app's own atom and the anonymous identity.

Every model gets create, read, update, and delete endpoints and a matching add-and-edit form, generated from its fields. Every index gets a query endpoint and a table view. Every edge in a result is a link to the referenced atom. The model's `rules` apply to both data and UI, because both resolve through the same path. There is no code generation step and no separate API or UI definition. The surface is computed from the atoms on each request.

## Addressing

Every reference is a URL. The same `atom://` string is used wherever a value, a link, or a query is expected: as an edge stored in `attr`, as a parameter in another query, as a route in the API, and as a link in the UI. A reference means the same thing in each place, so it is portable across all of them.

A URL has the form:

```
atom://<ref>[.<path>][?<query>]
```

- `<ref>` — an atom id, a model id, or an index id.
- `.<path>` — an optional dotted path that reads fields and edges from the result.
- `?<query>` — optional query parameters.

|URL                                          |Returns                                                       |
|---------------------------------------------|--------------------------------------------------------------|
|`atom://northwind`                           |the company record                                            |
|`atom://northwind.tier`                      |the value `enterprise`                                        |
|`atom://northwind.owner.team`                |`atom://team-west`, across two edges                          |
|`atom://northwind.contacts`                  |the inverse edge: every contact at the company                |
|`atom://contact`                             |every contact (the model's table)                             |
|`atom://openDeals?company=atom://northwind`  |the stored index, run with a parameter                        |
|`atom://deal?stage=qualified&sort=-amount`   |an ad-hoc query over a model's filterable fields              |

A query over a model filters on `filterable` fields and orders on `sortable` fields. The rules are:

- `key=value` matches equality.
- `key=a,b` matches any value in the list.
- `key>=value`, `key<=value`, `key>value`, `key<value` compare.
- Multiple parameters combine with AND.
- `sort=field` orders ascending; `sort=-field` orders descending.

A stored index names and reuses such a query. An ad-hoc query is the same query written inline on a model. Each URL resolves to data or to a rendered view through the same path, so every query is also a shareable link.

### Over HTTP

The kernel serves the address space under one host. `atom://<ref>` maps to `https://<host>/<ref>`. The HTTP method selects the operation:

|Method               |Operation                                                          |
|---------------------|-------------------------------------------------------------------|
|`GET /<id>`          |read an atom                                                       |
|`GET /<id>.<path>`   |read across a path                                                 |
|`GET /<model>?<query>`|run a query, return the result set                                |
|`POST /<model>`      |create an atom of that model (conflict if an explicit id exists)   |
|`PUT /<id>`          |replace an atom's `attr` wholesale, keeping its id and provenance   |
|`PATCH /<id>`        |partially update an atom; the `If-Match` header carries the version|
|`DELETE /<id>`       |retire an atom (set `lifecycle.status`)                            |

A model is created the same way as any record: `POST /model` with the model definition as the body. An index is created with `POST /index`. Defining a type and creating a record are the same operation on different models.

Run a query:

```
curl 'https://crm.example/deal?stage=qualified&sort=-amount'
```

Read across a path:

```
curl 'https://crm.example/northwind.owner.team'
```

Create an atom:

```
curl -X POST https://crm.example/contact \
  -H 'content-type: application/json' \
  -d '{
    "manifest": "Jane Roe, VP Eng at Northwind",
    "attr": {
      "name": "Jane Roe",
      "email": "jane@northwind.com",
      "company": "atom://northwind"
    }
  }'
```

The kernel generates `id`, fills `lifecycle`, sets `model` from the route, and validates `attr` against the contact model. If a contact with the same `byEmail` key exists, the write merges into it.

Post a model — define a new type by creating an atom whose model is `model`:

```
curl -X POST https://crm.example/model \
  -H 'content-type: application/json' \
  -d '{
    "manifest": "A task",
    "attr": {
      "label": "Task",
      "version": 1,
      "fields": {
        "title": { "kind": "text", "required": true },
        "done": { "kind": "boolean", "default": false }
      }
    }
  }'
```

The new `task` model is immediately addressable: `GET /task` returns its (empty) table and `POST /task` creates a task.

Update an atom:

```
curl -X PATCH https://crm.example/7b8f-2f0c \
  -H 'content-type: application/json' \
  -H 'if-match: 3' \
  -d '{ "attr": { "title": "VP Platform Engineering" } }'
```

The kernel commits only if the stored version still equals `3`. Otherwise it returns a conflict.

## Identity and access

Authentication and authorization are part of the kernel. Identity is an atom: a token. A token is an atom with grants — access to particular models and indexes. A user is a token. If a token has an email, the kernel signs it in by magic link.

### Token

A token is an atom scoped to refs by its grants. It is the `actor` that rules and grants are evaluated against. A token may carry an email so it can sign in, and it belongs to a tenant. An end user, an administrator, and an integration are all tokens; they differ only in their grants and whether they have an email.

```json
{
  "id": "tok-amy",
  "model": "atom://token",
  "manifest": "Amy Chen",
  "attr": {
    "email": "amy@acme.com",
    "team": "atom://team-west",
    "grants": [
      { "path": "**", "mode": "write" }
    ]
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-01-10T09:00:00Z",
    "createdBy": "atom://joey",
    "parent": "atom://acme"
  }
}
```

Edges that point at a person — `deal.owner`, `lifecycle.createdBy` — reference a token. There is no separate user atom to hold permissions out of band.

### Genesis: joey and atom://0

Two atoms are seeded when the store is initialized:

- **`atom://joey`** — the founding operator and root authority. It holds `**`, so it is the only principal that can mint capabilities. Every other token descends from it.
- **`atom://0`** — the genesis atom. joey writes it, and it is the origin of the core models (`model`, `index`, `token`, `tenant`, `session`, `migration`, and the rest), which carry `atom://0` as their `createdBy`. After install `atom://0` holds **no data grants**: it is the **anonymous identity**. An unauthenticated request resolves to `atom://0`.

So `"lifecycle": "atom://0"` on a kernel atom means "created at genesis by `atom://0`." Creating a new core type later (a model, token, or tenant) needs a grant on those types, which only descends from `atom://joey`.

```json
{
  "id": "0",
  "model": "atom://token",
  "manifest": "A data substrate where schema, data, identity, permissions, and every surface are all atoms — one organism, generated from the same core atoms and rendered on any surface.",
  "attr": {},
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z",
    "createdBy": "atom://joey",
    "parent": "atom://0",
    "expiration": "atom://policy-never"
  }
}
```

### The root is atom://0

The root of the surface is `atom://0` itself. `GET /` returns the `atom://0` atom; rendered, it shows that atom — id, model, and its manifest tagline — like any other record. The homepage is not special-cased — it is the root atom, drawn by the same machinery as every atom. `atom://0` is world-readable, so an unauthenticated caller sees the app's address and description but, holding no data grants, no records. A signed-out browser is offered a form to create a session; reading data requires one.

### Attenuation

A token can issue another token only with grants that are a subset of its own. It can never grant more than it holds. `atom://joey` holds `**`; every other token descends from it, equal or narrower. Issuing or editing a token is itself a write, gated by a grant on the `token` model. Access can only narrow as it spreads, so it cannot be minted out of band. To audit who can do what, follow the chain of tokens in the log.

### Sessions and magic-link sign-in

A token with an email signs in by magic link; the kernel then tracks that token through a session. There are no passwords.

- `POST /auth` with `{ "email": "amy@acme.com" }` mints a one-time code (15-minute expiry) and emails a link. It answers the same way whether or not the email maps to a token, so it cannot be used to enumerate accounts.
- Opening the link establishes a **session** — itself an atom (`atom://session`) that binds a cookie to the token. The session resolves to the token, which becomes the `actor`. The cookie is `HttpOnly; SameSite=Lax` (and `Secure` when served over TLS) with a full-entropy id, since it is a bearer credential. Signing out retires the session, and the caller falls back to `atom://0`.
- A token without an email does not sign in interactively. It is presented directly as a bearer credential — an integration is just such a token. There is no separate webhook or callback concept; an external system is an API caller holding a token.

### Provenance

Every atom records the token that created it in `lifecycle.createdBy` and the token that last changed it in `updatedBy`. The edge points back to the originating token, so its inverse — `atom://tok-amy.created` — lists everything that token made. The kernel models point at `atom://0` for the same reason.

### Tenant

The tenant is the parent atom. Every atom carries `lifecycle.parent` — the atom it lives under — and an atom's tenant is its nearest tenant ancestor (walk `parent`). A `tenant` atom is simply the boundary node; a token belongs to a tenant by being parented under it. Containment and tenancy are one structure.

A new atom is born into its creator's tenant: `parent` defaults to the writer's tenant. Isolation falls out of the tree — you can read or write an atom only if it shares your tenant ancestor. Global atoms (the core models, above any tenant) are visible to everyone; a token with no tenant is a superuser. An authorized caller may pass `parent` on create to place an atom under a chosen tenant — how root provisions a new tenant and the first token inside it. A tenant's members are the atoms parented under it.

### Grants

A grant gives a token access to a ref — a model, an index, or a single attribute path — for read or write. A path may use wildcards, so one grant covers many attributes across many atoms.

- A grant is `{ "path": "<path>", "mode": "read" | "create" | "update" | "delete" | "write" | "all" }`. The mode is the operation, and the HTTP method selects it: `GET`→read, `POST`→create, `PUT`/`PATCH`→update, `DELETE`→delete. `write` is the mutation superset (create + update + delete) and does **not** imply read; only `read` (or `all`) grants read.
- `*` matches one segment. `**` matches any number.
- The path is an ordinary path, so a grant can name a model (`contact.*`), an index (`openDeals`), or reach across edges.

A grant is itself a model (`{ path, mode }`), and `token.grants` is a `list` of `embed://grant`. Because the grant shape is declared, the kernel renders the grants editor as a repeater of path + mode rows — the auth schema edited through the same generated form as any other data.

|Grant path          |Covers                                          |
|--------------------|------------------------------------------------|
|`contact.*`         |every field of every contact (a model)          |
|`contact.email`     |only the email field of contacts                |
|`openDeals`         |the results of an index                         |
|`company.*.deals.**`|deals reached through any company field         |
|`**`                |everything in the token's tenant (an admin)     |

### Role

Grants can live on the token directly, or be bundled into a **role** and shared. A `role` atom is `{ label, grants }` — a named set of grants. A token references roles through `attr.roles` (a list of `atom://role-…`), and its effective grants are its own plus the union of its roles'. Change a role once and every token wearing it changes with it. Attenuation still applies to whatever a token ends up holding.

```json
{ "id": "role-website", "model": "atom://role", "manifest": "Website intake",
  "attr": { "label": "Website intake", "grants": [
    { "path": "advocate.name", "mode": "write" },
    { "path": "advocate.email", "mode": "write" },
    { "path": "advocate.address", "mode": "write" }
  ] } }
```

A public intake token then just wears the role: `"attr": { "login": "open", "roles": ["atom://role-website"] }` — write-only, no read, nothing inline.

### Hooks (the Logic primitive, as capabilities)

A hook is a capability atom `{ run, grants }` whose `run` names a handler in `scripts/`. It is **registered in an atom's `lifecycle.hooks`**, keyed by event (`create` / `update` / `delete`). On a write, the kernel runs the hooks declared on the atom itself *and* on its model atom — so a hook on a model fires for every instance, a hook on one atom fires for just that one.

The hook runs under **its own grants** (attenuated when it was created), never the caller's. So the caller needs **no invoke permission**: writing the atom is enough, and the hook can only do what it holds. This is how a write-only public form can trigger privileged enrichment safely — e.g. the advocate model registers `census-district`, which geocodes the submitted address and writes the congressional-district link the submitter could never write directly.

```json
"lifecycle": { "hooks": { "create": ["atom://census-district"], "update": ["atom://census-district"] } }
```

### Read filtering

Access is evaluated per attribute, not only per atom. When the kernel returns an atom, it walks each attribute's path and keeps the attribute only if the actor holds a matching read grant. Attributes without a grant are redacted: they are removed from the response, and full-text and filters do not expose them. Two actors reading the same atom can receive different subsets. This is how PII is withheld — an actor without a grant for `contact.email` sees the contact but not the email.

The model's `rules.read` gates the atom as a whole. Grants gate the attributes within it. Access is the intersection of both, and is denied by default.

## Correctness

**Identity and deduplication.** On create, the kernel checks the model's `identity` indexes. If a record with the same key exists, the write is merged into it (per `behavior.merge`) instead of inserting a duplicate. The `id` is not used for matching. By default `id` is a generated surrogate. `behavior.addressing: content` derives `id` from the identity key and is allowed only for immutable, single-key models.

**Concurrency.** A write carries the `lifecycle.version` it read. The kernel commits the write only if the stored version is unchanged. Otherwise it returns a conflict for the caller to retry. A model may opt into last-writer-wins.

**Provenance.** The log records every change at field level: actor, time, old value, new value. A field's full history is its log entries. Audit and point-in-time queries read the same log. Values computed on read are not stored. Values that are audited or billed are written so they are indexed, logged, and fixed at write time.

**Permissions.** A model's `rules` hold `read` and `write` predicates over the whole atom, written as path expressions. The actor's `grants` then gate access per attribute path (see Identity and access). Access is the intersection of rules and grants. A predicate that is false, errors, or exceeds its traversal budget denies access. Access is never granted by default.

## Schema evolution

Each model has a `version`. Adding an optional field does not change it. Existing records stay valid. A breaking change (rename, retype, new required field, removal, or identity change) increments `version` and ships a `migration` atom. A migration is immutable and applies in one direction only.

Each record stores the `modelVersion` it was written under. When a record is behind the current version, the kernel applies the contiguous chain of migrations in order, returns the current shape, and rewrites the record forward — the new shape is persisted and the rewrite is logged as a `migrate` ledger entry, exactly like any other change. A record already at the current version is a single integer comparison and a no-op.

The sweep runs in three places, so the migrated shape is what every reader sees: on **read** of a single record (the literal version-bump-on-read), on every **schema change** (shipping a model write or a new `migration` atom sweeps that model's records immediately), and to completion on **boot** (the background job that catches anything added while the process was down). Migrations apply lazily and idempotently; a gap in the chain stops the walk at that version rather than skipping it.

`op: rename` moves a field (`spec: { from, to }`); `op: default` fills a new field (`spec: { field, value }`); both are applied by the kernel. `op: custom` runs a named handler in `scripts/<run>.mjs` — `run` is locked to a safe basename (no path traversal), the same vetting hooks get — that receives the record's `attr` and returns the next one. Authoring a custom migration's script is operator-only (server code), the same single privileged act as authoring a hook's script; shipping a `rename`/`default` migration is ordinary atom CRUD, gated by a grant on the `migration` model.

```json
{
  "id": "contact@1->2",
  "model": "atom://migration",
  "manifest": "Split name into firstName + lastName",
  "attr": {
    "model": "atom://contact",
    "from": 1,
    "to": 2,
    "op": "custom",
    "run": "splitName"
  },
  "lifecycle": "atom://0"
}
```

## Example: CRM

Three models define a CRM. `contact` and `deal` hold an `atom://company` edge. The `inverse` on each edge makes `company.contacts` and `company.deals` queryable without a separate declaration. `company.owner` references the token that owns the account (`atom://tok-amy`) and is used by the contact write rule. `company.hq` embeds an address with `embed://address`. The models below show optional `display` hints; the kernel would render them from field kinds without those hints.

The model definitions are created by `atom://0` — defining a type needs `model` scope, which only the root and the tokens it grants hold. The records that follow are created by `atom://tok-amy`, an application token without that scope.

### Models

```json
{
  "id": "company",
  "model": "atom://model",
  "manifest": "An organization in the CRM",
  "attr": {
    "label": "Company",
    "version": 1,
    "fields": {
      "name": {
        "kind": "text",
        "required": true
      },
      "domain": {
        "kind": "text"
      },
      "hq": "embed://address",
      "owner": {
        "kind": "ref",
        "to": "atom://token"
      },
      "tier": {
        "kind": "enum",
        "values": [
          "smb",
          "mid",
          "enterprise"
        ],
        "filterable": true
      }
    },
    "indexes": {
      "byDomain": {
        "on": [
          "domain"
        ],
        "role": "identity"
      },
      "byName": {
        "on": [
          "name"
        ],
        "role": "identity"
      }
    },
    "display": {
      "row": [
        "name",
        "tier"
      ],
      "detail": [
        "name",
        "domain",
        "hq",
        "owner",
        "contacts",
        "deals"
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "merge"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "contact",
  "model": "atom://model",
  "manifest": "A person at a company",
  "attr": {
    "label": "Contact",
    "version": 1,
    "fields": {
      "name": {
        "kind": "text",
        "required": true
      },
      "email": {
        "kind": "text"
      },
      "title": {
        "kind": "text"
      },
      "company": {
        "kind": "ref",
        "to": "atom://company",
        "inverse": "contacts"
      }
    },
    "indexes": {
      "byEmail": {
        "on": [
          "email"
        ],
        "role": "identity"
      }
    },
    "display": {
      "row": [
        "name",
        "title",
        "company"
      ]
    },
    "rules": {
      "read": "true",
      "write": "actor.team == company.owner.team"
    },
    "behavior": {
      "mutable": true,
      "merge": "merge"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "deal",
  "model": "atom://model",
  "manifest": "A sales opportunity",
  "attr": {
    "label": "Deal",
    "version": 1,
    "fields": {
      "name": {
        "kind": "text",
        "required": true
      },
      "amount": {
        "kind": "number",
        "filterable": true,
        "sortable": true
      },
      "stage": {
        "kind": "enum",
        "values": [
          "lead",
          "qualified",
          "won",
          "lost"
        ],
        "filterable": true
      },
      "company": {
        "kind": "ref",
        "to": "atom://company",
        "inverse": "deals"
      },
      "owner": {
        "kind": "ref",
        "to": "atom://token"
      }
    },
    "display": {
      "row": [
        "name",
        "amount",
        "stage"
      ],
      "board": {
        "groupBy": "stage",
        "card": [
          "name",
          "amount",
          "company"
        ]
      }
    },
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

### Records

One company, two contacts, and a deal. The owner and the `createdBy`/`updatedBy` actors are the token `atom://tok-amy`, a member of the `acme` tenant. `hq` holds resolved address values (no `embed://` in stored data). The `company` edges all point at `atom://northwind`.

```json
{
  "id": "northwind",
  "model": "atom://company",
  "manifest": "Northwind Traders, enterprise account",
  "attr": {
    "name": "Northwind Traders",
    "domain": "northwind.com",
    "hq": {
      "street": "500 Market St",
      "city": "Seattle",
      "state": "WA",
      "zip": "98101",
      "country": "US"
    },
    "owner": "atom://tok-amy",
    "tier": "enterprise"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-20T09:00:00Z",
    "createdBy": "atom://tok-amy"
  }
}
```

```json
{
  "id": "7b8f-2f0c",
  "model": "atom://contact",
  "manifest": "Jane Roe, VP Eng at Northwind",
  "attr": {
    "name": "Jane Roe",
    "email": "jane@northwind.com",
    "title": "VP Engineering",
    "company": "atom://northwind"
  },
  "lifecycle": {
    "status": "active",
    "version": 3,
    "modelVersion": 1,
    "createdAt": "2026-05-28T12:00:00Z",
    "createdBy": "atom://tok-amy",
    "updatedAt": "2026-05-28T15:20:00Z",
    "updatedBy": "atom://tok-amy"
  }
}
```

```json
{
  "id": "a31c-90fe",
  "model": "atom://contact",
  "manifest": "John Vega, CFO at Northwind",
  "attr": {
    "name": "John Vega",
    "email": "john@northwind.com",
    "title": "CFO",
    "company": "atom://northwind"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-28T12:05:00Z",
    "createdBy": "atom://tok-amy"
  }
}
```

```json
{
  "id": "deal-9001",
  "model": "atom://deal",
  "manifest": "Northwind platform expansion",
  "attr": {
    "name": "Platform expansion",
    "amount": 120000,
    "stage": "qualified",
    "company": "atom://northwind",
    "owner": "atom://tok-amy"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-25T16:00:00Z",
    "createdBy": "atom://tok-amy"
  }
}
```

### Resolving

- `atom://northwind` → the company record above.
- `atom://northwind.contacts` → `[ atom://7b8f-2f0c, atom://a31c-90fe ]` (the inverse of `contact.company`).
- `atom://northwind.deals` → `[ atom://deal-9001 ]` (the inverse of `deal.company`).
- `atom://7b8f-2f0c.company.owner.team` → `atom://team-west` (path across two edges).
- `atom://openDeals?company=atom://northwind` → `[ atom://deal-9001 ]` (stage in lead/qualified, sorted by amount).
- Writing a second contact with `email: jane@northwind.com` matches the `byEmail` identity index and merges into `atom://7b8f-2f0c` instead of creating a duplicate.

## Example: a website signup form

A public website collects signups. The form is a model atom that embeds the contact model. Embedding inlines the contact's fields into each registration, so a registration is one record and not a separate shared contact. The person fields are defined once on `contact` and reused here.

```json
{
  "id": "registration",
  "model": "atom://model",
  "manifest": "Website signup form",
  "attr": {
    "label": "Registration",
    "version": 1,
    "fields": {
      "contact": "embed://contact",
      "source": {
        "kind": "text",
        "default": "website"
      },
      "consent": {
        "kind": "boolean",
        "required": true
      }
    },
    "rules": {
      "read": "actor.tenant == atom://acme",
      "write": "true"
    }
  },
  "lifecycle": "atom://0"
}
```

`write: "true"` lets the form accept a submission from a low-privilege caller; `read` keeps submissions internal to the tenant. Public access is carried by a **write-only open-login intake token** (the same pattern as CapConnect in Demo B), not by a truly anonymous principal: the genesis anonymous identity `atom://0` holds no grants and cannot write. A visitor one-clicks into the intake token (or the page mounts it as a bearer credential), and that token — attenuated to just this form — is the `createdBy` on each submission.

The form is made from the contact model. Because `contact` is `embed://contact`, the person inputs come straight from the contact model's fields. The contact model is defined once and drives both the CRM's contact records and this public form. The `source` and `consent` fields are added by the registration model on top of the embedded contact.

The website mounts the generated form by reference. The kernel renders inputs from field kinds: the embedded contact expands into its `name`, `email`, and `title` fields, `consent` becomes a checkbox, and `source` is hidden with its default.

```html
<div data-atom="atom://registration"></div>
<script src="https://crm.example/embed.js"></script>
```

A submission is a POST that creates one registration atom with the contact fields inline:

```
curl -X POST https://crm.example/registration \
  -H 'content-type: application/json' \
  -d '{
    "attr": {
      "contact": {
        "name": "Sam Lee",
        "email": "sam@acme.com"
      },
      "consent": true
    }
  }'
```

The kernel validates the embedded `contact` values against the contact model, fills `source` from its default, generates `id` and `lifecycle` — `createdBy` is the write-only intake token the public form carries — and stores the registration. The stored record holds resolved values, with no `embed://` string and no `id` or `lifecycle` on the embedded contact:

```json
{
  "id": "c4d2-71aa",
  "model": "atom://registration",
  "manifest": "Sam Lee, signup from website",
  "attr": {
    "contact": {
      "name": "Sam Lee",
      "email": "sam@acme.com"
    },
    "source": "website",
    "consent": true
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-30T18:00:00Z",
    "createdBy": "atom://tok-intake"
  }
}
```

`GET /registration` returns the table of signups for sales. Each row shows the embedded contact fields.

## Example: outreach through the API

Outreach needs no special webhook. An external system is an API caller. It authenticates with a token, and the token carries grants. The outreach tool's token has one grant: write to the contact model. An admin token (`atom://tok-amy`) issued it, so by attenuation its grant is a subset of that admin's — its `createdBy` is that admin, not the root.

```json
{
  "id": "tok-outreach",
  "model": "atom://token",
  "manifest": "Outreach integration credential",
  "attr": {
    "grants": [
      {
        "path": "contact.*",
        "mode": "write"
      }
    ]
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-30T00:00:00Z",
    "createdBy": "atom://tok-amy",
    "parent": "atom://acme"
  }
}
```

The caller creates a contact with the same POST a person would, scoped to its grant:

```
curl -X POST https://crm.example/contact \
  -H 'authorization: Bearer tok-outreach' \
  -H 'content-type: application/json' \
  -d '{
    "attr": {
      "name": "Dana Cruz",
      "email": "dana@acme.com",
      "company": "atom://northwind"
    }
  }'
```

The kernel resolves the token to its actor, checks the `contact.*` write grant, validates the body against the contact model, and writes. A write to a path the token does not grant — a deal, or the tenant's members — is denied. The `byEmail` identity index dedups, so re-sending the same contact merges into the existing one instead of creating a duplicate.

### The ledger

Atom CRUD is the ledger. Every write — `create`, `merge`, `update`, `replace`, `delete`, and each hook `patch` — appends one `log` atom (and the genesis seed logs itself), keyed by a sequential `log-<n>` id. The log is append-only and remains the **audit trail** of every change, entry by entry. (State itself is now authoritative in the `atom` table, written through on each change, rather than being reconstructed by folding the log on boot — so the ledger is a record of history, no longer the thing replayed to rebuild the present.) A log atom shares its subject's `shard`, so a tenant's history stays with its data; the store is auditable and replicable entry by entry.

```json
{
  "id": "log-148",
  "model": "atom://log",
  "manifest": "create contact dana",
  "attr": {
    "atom": "atom://e8a1-0c4d",
    "op": "create",
    "actor": "atom://tok-outreach",
    "at": "2026-05-30T18:05:00Z",
    "changes": [
      {
        "path": "name",
        "from": null,
        "to": "Dana Cruz"
      },
      {
        "path": "email",
        "from": null,
        "to": "dana@acme.com"
      },
      {
        "path": "company",
        "from": null,
        "to": "atom://northwind"
      }
    ]
  },
  "lifecycle": "atom://0"
}
```

The actor on the entry is the outreach token, so every atom the integration creates is attributable to it. A later reader still sees `email` only if their own grants allow it; the writer's grant does not widen anyone else's read.

## Reference kernel

`atomic.mjs` is a minimal, dependency-free implementation of this spec — run it with `node atomic.mjs` (Node ≥ 22.5 for the built-in `node:sqlite`; ≥ 24 unflagged); `node test.mjs` is the smoke test. It implements: atoms, models that validate `attr` (incl. semantic `email`/`url`/`uuid` and `min`/`max`/`pattern`), the `atom://0`←`atom://joey` genesis, CRUD over HTTP (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`), path/edge/inverse resolution with a traversal budget, ad-hoc queries, full-text search (`?q=`), stored indexes (parameterised + date-paginated), tokens with method-based grants, **enforced attenuation**, **`rules` predicates**, attribute redaction, magic-link sessions, tenancy as `lifecycle.parent`, a hardened HTTP surface (security headers, strict CSP, a static same-origin client), opt-in AES-256-GCM encryption at rest, lazy schema migration (`rename`/`default`/`custom`, applied on read and swept on schema change and boot), a `--audit` governance self-check, and a surface that renders every atom from its model — root included.

The kernel ships no sample data — only the genesis (`joey@emailjoey.com` as admin), the core models, and the core indexes; its table styling is an inlined stylesheet served at `/style.css`. Four demo tenants are loaded over the API by `seeds/seed-a.mjs` (a PAC: a reporting chain and 100 fundraising transactions), `seeds/seed-b.mjs` (an advocacy program: stories → advocates → districts → elected officials), `seeds/seed-c.mjs` (a hybrid), and `seeds/seed-d.mjs` (a household: rooms, belongings, and residents as first-class edges) — `npm run seed`.

Persistence is durable, indexed, and ACID: set `ATOMIC_STORE=<dir>` and state lives in an embedded SQLite database (`<dir>/atoms.db`, WAL mode) — one `atom` table (`id, shard, model, body`) indexed on `shard` (= tenant) and `model` (= type). State is authoritative in the table and written through on each change, so there is **no boot-time replay** and the working set need not fit in RAM. The store is `node:sqlite` — part of the Node runtime, so the kernel stays dependency-free and a single file. Reads route through the `getStore(actor)`/`store.query({shards, model})` seam, which pushes the tenant + type filter into SQL so a read hits an index and never materializes atoms outside its scope — the mechanism that holds up at billions of atoms per tenant. A pre-existing per-tenant NDJSON store (the previous format) migrates itself into `atoms.db` on first boot, last-write-wins, leaving the old logs as `.migrated`. Set `ATOMIC_KEY` and each atom's `body` is sealed with AES-256-GCM (confidential and tamper-evident; `id/shard/model` stay plaintext for routing and indexing); unset, the body is plaintext, and reads accept either form per row, so turning the key on is forward-only. Unset `ATOMIC_STORE` runs in-memory (the default). `node atomic.mjs --audit` runs the governance self-check (`npm run audit`) and exits non-zero on any structural finding. The one genuinely unbuilt capability is **`attr`-field indexing**: a filter or sort on a value *inside* a record is a JS scan over the tenant/model-scoped set, not index-backed (and a stored index doesn't change that — a named scan whose key isn't a structural column is still a scan). Building it well means a generic kernel-maintained secondary index (not a schema-aware SQL column — that would be Fork B), and under `ATOMIC_KEY` it is necessarily partial: equality via a keyed blind index, but not range/sort without leaking order. Over the default plaintext store it is straightforward (equality, range, and sort). See "Open threads" above.

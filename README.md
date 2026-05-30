# Atomic

Atomic stores data and its definitions as one kind of record. A model defines a type. Its API, queries, permissions, and rendering come from that definition. There is no separate ORM, API layer, or UI configuration.

Atomic is a data substrate for graph-relational, queryable stores such as a CRM. Every record is an atom. The schema that defines other records is also made of atoms. Relationships are typed edges. Queries, constraints, permissions, and migrations are atoms and run by one kernel.

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
    "createdBy": "atom://u-amy",
    "updatedAt": "2026-05-28T15:20:00Z",
    "updatedBy": "atom://u-amy"
  }
}
```

|Field      |Definition                                                                                            |
|-----------|------------------------------------------------------------------------------------------------------|
|`id`       |Unique, opaque, immutable identifier. The reference route is `atom://id`.                              |
|`model`    |A pointer to the model atom that defines this record's type. This pointer is the record's identity.   |
|`manifest` |Free-text description. Set through CRUD. Full-text indexed.                                            |
|`attr`     |The record's values. The model validates them. `ref` values are edges.                                |
|`lifecycle`|Kernel-managed: `status`, `version` (write count), `modelVersion`, and created/updated actor and time.|

`id` is opaque and never changes. References stay valid when data changes. Domain timestamps such as `closedAt` go in `attr`. `lifecycle` holds operational metadata only.

## Model

A model is an atom that defines a type. It lists the type's fields, indexes, and rules. The kernel's own types — `model`, `index`, `hook`, `migration`, `token`, `config`, `file`, `log`, `plugin`, `tenant` — are themselves model atoms.

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
- `ref`: a reference to a standalone atom. Declares `to` (target model) and optional `inverse`. Stored as a link to a separate record.
- Containers: `list`, `map`, `json`.
- Modifiers: `required`, `default`, `unique`, `filterable`, `sortable`.

## Kernel atoms

The system is made of atoms. The kernel's own types are model atoms, so the kernel runs on the same machinery as the data it stores. These are the models that make the system work:

|Model      |What it is                                                                 |
|-----------|---------------------------------------------------------------------------|
|`model`    |Defines a type: its fields, indexes, and rules. Validates atoms of that type.|
|`index`    |A stored query or constraint over a model's atoms.                         |
|`migration`|A one-way transform that moves a model from one version to the next.       |
|`token`    |A credential. Resolves to an actor and carries grants.                     |
|`user`     |A person who can authenticate and act: email, tenant, and grants.          |
|`tenant`   |An isolation boundary. Atoms, grants, and rules are scoped to it.          |
|`log`      |An append-only entry recording one change to one atom. The ledger.         |
|`file`     |A stored blob, addressed like any atom.                                    |
|`config`   |Kernel and tenant settings.                                                |
|`plugin`   |A bundle of models, indexes, and handlers installed together.              |
|`hook`     |A handler that runs on a write — the transform side of Logic.              |

Everything else — companies, contacts, deals, signups — is an application model built the same way. There is no privileged layer: defining a type, granting access, recording a change, and storing a record are all atom CRUD.

## References

A model's field definitions use two reference schemes:

- **`atom://x`** — an edge to a standalone atom `x`. Stored as a live link. Reads see `x`'s current values.
- **`embed://x`** — inline the fields of model `x` here. Resolved when the schema compiles. The values are stored in the parent record's `attr` and validated against `x`. They carry no `id` or `lifecycle`.

`embed://` appears only in model definitions, never in stored records. A record holds resolved values, not the `embed://` string. Any model can be embedded by referencing it with `embed://`. The same model can also be used as a standalone atom elsewhere via `atom://`.

Use `atom://` when the target is a record that exists on its own and may be shared (a company, a user). Use `embed://` for a field group that belongs to one parent and is not shared (an address).

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

## Rendering

A client renders an atom from its model's field kinds. Each kind has a default rendering: `text` is a text cell, `enum` is a fixed set of values, `ref` is a link to another atom, `datetime` is a date, `boolean` is a toggle. No extra definition is needed to render or edit any atom.

A model may add an optional `display` attr to curate the default: which fields appear, in what order, and how they group. `row` curates tables, `detail` curates a single record, `board` groups records into columns. `display` is a hint. When it is absent, the client renders from field kinds. A dashboard is a set of saved indexes plus optional display hints.

## Surface

The kernel exposes one address space. Every atom, model, and index is reachable by its `atom://` reference. A reference is both an API endpoint and a UI route. The kernel returns the same resource as data or as a rendered view, depending on the request.

- `atom://<id>` — a single record. As data, the atom JSON. As UI, its detail view, rendered from the model's field kinds.
- `atom://<model>` — a model. As data, the model definition. As UI, a table of every atom of that model, with an add form generated from the model's fields.
- `atom://<index>?<params>` — runs the index. As data, the result set. As UI, a table or board of the matching atoms.

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
|`POST /<model>`      |create an atom of that model from a JSON body                      |
|`PATCH /<id>`        |update an atom; the `If-Match` header carries the version read     |
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

Authentication and authorization are part of the kernel. A user is an atom. Access is granted by path.

### User

`user` is a core model. A user atom has an email, a tenant, and a list of grants. The signed-in user atom is the `actor` that rules and grants are evaluated against. Any atom that fits this shape — an email and a set of grants — is a user.

```json
{
  "id": "user",
  "model": "atom://model",
  "manifest": "A person who can authenticate and act",
  "attr": {
    "label": "User",
    "version": 1,
    "fields": {
      "email": {
        "kind": "text",
        "required": true,
        "unique": true
      },
      "name": {
        "kind": "text"
      },
      "tenant": {
        "kind": "ref",
        "to": "atom://tenant"
      },
      "grants": {
        "kind": "list"
      }
    },
    "indexes": {
      "byEmail": {
        "on": [
          "email"
        ],
        "role": "identity"
      }
    }
  },
  "lifecycle": "atom://0"
}
```

### Magic-link sign-in

The kernel signs users in by email. There are no passwords.

- `POST /auth` with `{ "email": "amy@northwind.com" }` finds the user through the `byEmail` index, mints a short-lived `token` atom, and emails a link containing it.
- Opening the link exchanges the token for a session. The session resolves to the user atom, which becomes `actor`.
- A magic-link `token` is single-use and short-lived. `token` is a kernel model, logged like any atom.

### Callers

A caller is anything that holds a token: a person signed in by magic link, or an integration issued a token directly. An integration token is long-lived and carries its own grants. Grants attach to the user or to the token, and the `actor` is whatever the token resolves to. Access is checked the same way for both. An integration such as an outreach tool gets a token with only the grants it needs — there is no separate webhook or callback concept; an external system is just an API caller.

### Tenant

Every user belongs to a `tenant`. New atoms are created in the actor's tenant. Grants and rules are evaluated within it. Access across tenants is denied unless a grant allows it.

### Grants

A grant gives the actor access to a path, for read or write. A path may use wildcards, so one grant covers many attributes across many atoms.

- A grant is `{ "path": "<path>", "mode": "read" | "write" }`.
- `*` matches one segment. `**` matches any number.
- The path is an ordinary path, so a grant can reach across edges.

|Grant path          |Covers                                          |
|--------------------|------------------------------------------------|
|`contact.*`         |every field of every contact                    |
|`contact.email`     |only the email field of contacts                |
|`company.*.deals.**`|deals reached through any company field         |
|`**`                |everything in the tenant (an admin)             |

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

Each record stores the `modelVersion` it was written under. When a record is behind the current version, the kernel applies the migrations in order on read and returns the current shape. The record is rewritten to the new shape on its next write. A background job rewrites records that are never otherwise written.

`op: rename` and `op: default` are applied by the kernel from `spec`. `op: custom` runs a named handler. A field is fully migrated only after the background job completes. Run it to completion before filtering, searching, or billing on that field.

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

Three models define a CRM. `contact` and `deal` hold an `atom://company` edge. The `inverse` on each edge makes `company.contacts` and `company.deals` queryable without a separate declaration. `company.owner` is an `atom://user` edge used by the contact write rule. `company.hq` embeds an address with `embed://address`. The models below show optional `display` hints; the kernel would render them from field kinds without those hints.

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
        "to": "atom://user"
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
        "to": "atom://user"
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

One company, its owner, two contacts, and a deal. `hq` holds resolved address values (no `embed://` in stored data). The `company` edges all point at `atom://northwind`.

```json
{
  "id": "u-amy",
  "model": "atom://user",
  "manifest": "Amy Chen, account executive",
  "attr": {
    "name": "Amy Chen",
    "team": "atom://team-west"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-01-10T09:00:00Z",
    "createdBy": "atom://u-root"
  }
}
```

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
    "owner": "atom://u-amy",
    "tier": "enterprise"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-20T09:00:00Z",
    "createdBy": "atom://u-amy"
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
    "createdBy": "atom://u-amy",
    "updatedAt": "2026-05-28T15:20:00Z",
    "updatedBy": "atom://u-amy"
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
    "createdBy": "atom://u-amy"
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
    "owner": "atom://u-amy"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "modelVersion": 1,
    "createdAt": "2026-05-25T16:00:00Z",
    "createdBy": "atom://u-amy"
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
      "read": "actor.team == 'sales'",
      "write": "true"
    }
  },
  "lifecycle": "atom://0"
}
```

`write: "true"` lets anyone submit. `read` keeps submissions internal to the sales team.

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

The kernel validates the embedded `contact` values against the contact model, fills `source` from its default, generates `id` and `lifecycle`, and stores the registration. The stored record holds resolved values, with no `embed://` string and no `id` or `lifecycle` on the embedded contact:

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
    "createdBy": "atom://anon"
  }
}
```

`GET /registration` returns the table of signups for sales. Each row shows the embedded contact fields.

## Example: outreach through the API

Outreach needs no special webhook. An external system is an API caller. It authenticates with a token, and the token carries grants. The outreach tool's token has one grant: write to the contact model.

```json
{
  "id": "tok-outreach",
  "model": "atom://token",
  "manifest": "Outreach integration credential",
  "attr": {
    "tenant": "atom://tenant-acme",
    "grants": [
      {
        "path": "contact.*",
        "mode": "write"
      }
    ]
  },
  "lifecycle": "atom://0"
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

The kernel resolves the token to its actor, checks the `contact.*` write grant, validates the body against the contact model, and writes. A write to a path the token does not grant — a deal, a user — is denied. The `byEmail` identity index dedups, so re-sending the same contact merges into the existing one instead of creating a duplicate.

### The ledger

Atom CRUD is the ledger. Every create, update, and delete appends one `log` atom. The log is append-only, and the current state of an atom is the fold of its log entries. Replaying the log rebuilds every atom, so the store is auditable and can be replicated entry by entry.

```json
{
  "id": "log-9c20",
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

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

## Correctness

**Identity and deduplication.** On create, the kernel checks the model's `identity` indexes. If a record with the same key exists, the write is merged into it (per `behavior.merge`) instead of inserting a duplicate. The `id` is not used for matching. By default `id` is a generated surrogate. `behavior.addressing: content` derives `id` from the identity key and is allowed only for immutable, single-key models.

**Concurrency.** A write carries the `lifecycle.version` it read. The kernel commits the write only if the stored version is unchanged. Otherwise it returns a conflict for the caller to retry. A model may opt into last-writer-wins.

**Provenance.** The log records every change at field level: actor, time, old value, new value. A field's full history is its log entries. Audit and point-in-time queries read the same log. Values computed on read are not stored. Values that are audited or billed are written so they are indexed, logged, and fixed at write time.

**Permissions.** A model's `rules` hold `read` and `write` predicates, written as path expressions. A predicate that is false, errors, or exceeds its traversal budget denies access. Access is never granted by default.

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

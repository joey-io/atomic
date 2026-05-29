# Atomic

Traditionally, interfaces are built on top of schema. Atomic makes them one: define a model, and its API, queries, permissions, and UI come from that definition.

Atomic is a data substrate for graph-relational, queryable stores such as CRM. Every record is an atom, including the schema that defines other records. Relationships are typed edges. Queries, constraints, permissions, rendering, and migrations are stored as atoms and run by one kernel.

## Primitives

Atomic is built from six concepts:

1. **Atom** — a record: `{ id, model, manifest, attr, lifecycle }`.
1. **Model** — defines a type’s fields, indexes, display, and rules.
1. **Index** — a query or constraint over a model’s fields.
1. **Path** — a dotted expression for reading across fields and edges.
1. **Logic** — a rule or transform, written as a path expression or a handler.
1. **Log** — an append-only record of every change.

## Atom

Every record has the same five fields.

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
|`id`       |Unique, opaque, immutable identifier. The reference route is `atom://id`.                             |
|`model`    |Reference to the model atom that defines this record’s type.                                          |
|`manifest` |Free-text description. Set through CRUD; full-text indexed.                                           |
|`attr`     |The record’s values, shaped by its model. `ref` values are edges.                                     |
|`lifecycle`|Kernel-managed: `status`, `version` (write count), `modelVersion`, and created/updated actor and time.|

`id` is opaque and never changes, so references remain valid when data changes. Domain timestamps such as `closedAt` go in `attr`; `lifecycle` holds operational metadata only.

## Model

A model is an atom that defines a type. It lists the type’s fields, indexes, display layouts, and rules. The kernel’s own types — `model`, `index`, `hook`, `migration`, `token`, `config`, `file`, `log`, `plugin`, `tenant` — are themselves model atoms.

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
      "display": {
        "kind": "json"
      },
      "rules": {
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
    "display": {
      "row": [
        "label",
        "id"
      ]
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

Two reference schemes appear in a model’s field definitions:

- **`atom://x`** — an edge to a standalone atom `x`. Stored as a live link; reads see `x`’s current values.
- **`embed://x`** — inline the fields of model `x` here. Resolved when the schema compiles. The field’s values are stored in the parent record’s `attr` and validated against `x`; they carry no `id` or `lifecycle`.

`embed://` appears only in model definitions, never in stored records. A record holds resolved values, not the `embed://` string. Any model can be embedded by referencing it with `embed://`; the same model may also be used as a standalone atom elsewhere via `atom://`.

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

An `atom://` field is an edge. With `inverse` set, the kernel maintains the reverse edge automatically, so both directions are queryable. A path is a dotted expression that reads across edges and nested values:

```
deal.company.owner.team
```

Paths are used in filters, indexes, rules, display, and exports. Traversal follows these rules:

- References may form cycles. Traversal tracks visited atoms and stops when it revisits one; there is no fixed depth limit.
- Each traversal runs under a budget (time, atoms visited, result size). Callers may raise the budget.
- A reference to a missing atom is an error, not a null.
- Resolved references are cached and invalidated when the target changes.

## Index

An index is a query or constraint over a model’s fields. It declares `over`, `params`, `match`, `sort`, `returns`, and a `role`:

- `filter` / `sort`: a parameterized query.
- `unique`: rejects a write that would duplicate the key.
- `identity`: a unique key used to detect duplicates on create.
- `inverse`: the reverse side of an `atom://` edge, exposed as a field on the target.

The `unique` and `inverse` field modifiers are shorthand for indexes. An index is run by referencing it with parameters:

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

## Display

A model’s `display` defines how its records render: `row` for tables, `detail` for a single record, `board` for grouped views. The kernel generates the UI from these definitions. A dashboard is a set of saved indexes plus their display layouts.

## Correctness

**Identity and deduplication.** On create, the kernel checks the model’s `identity` indexes. If a record with the same key exists, the write is merged into it (per `behavior.merge`) instead of inserting a duplicate. The `id` is not used for matching. By default `id` is a generated surrogate; `behavior.addressing: content` derives `id` from the identity key and is allowed only for immutable, single-key models.

**Concurrency.** A write carries the `lifecycle.version` it read. The kernel commits the write only if the stored version is unchanged; otherwise it returns a conflict for the caller to retry. A model may opt into last-writer-wins.

**Provenance.** The log records every change at field level: actor, time, old value, new value. A field’s full history is its log entries. Audit and point-in-time queries read the same log. Values computed on read are not stored; values that are audited or billed are written so they are indexed, logged, and fixed at write time.

**Permissions.** A model’s `rules` hold `read` and `write` predicates, written as path expressions. A predicate that is false, errors, or exceeds its traversal budget denies access. Access is never granted by default.

## Schema evolution

Each model has a `version`. Adding an optional field does not change it; existing records stay valid. A breaking change (rename, retype, new required field, removal, or identity change) increments `version` and ships a `migration` atom, which is immutable and applies in one direction only.

Each record stores the `modelVersion` it was written under. When a record is behind the current version, the kernel applies the migrations in order on read and returns the current shape. The record is rewritten to the new shape on its next write. A background job rewrites records that are never otherwise written.

`op: rename` and `op: default` are applied by the kernel from `spec`. `op: custom` runs a named handler. A field is fully migrated only after the background job completes; run it to completion before filtering, searching, or billing on that field.

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

Three models define a CRM. `contact` and `deal` hold an `atom://company` edge; the `inverse` on each edge makes `company.contacts` and `company.deals` queryable without a separate declaration. `company.owner` is an `atom://user` edge used by the contact write rule. `company.hq` embeds an address with `embed://address`.

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
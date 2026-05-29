# Atomic

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
- `ref`: a reference to another model. A reference to a standalone model is a graph edge; a reference to an embedded model inlines that model’s fields.
- Containers: `list`, `map`, `json`.
- Modifiers: `required`, `default`, `unique`, `filterable`, `sortable`.

**Embedded models**

A model with `behavior.embedded: true` has no standalone records. Its fields are inlined wherever it is referenced and carry no `id` or `lifecycle` of their own. This is how reusable field groups are defined.

```json
{
  "id": "address",
  "model": "atom://model",
  "manifest": "Embedded address",
  "attr": {
    "label": "Address",
    "behavior": {
      "embedded": true
    },
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

A `ref` field is an edge. It declares `to` (the target model) and an optional `inverse` (a field name on the target). When `inverse` is set, the kernel maintains the reverse edge automatically, so both directions are queryable.

A path is a dotted expression that reads across edges and nested values:

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
- `inverse`: the reverse side of a `ref`, exposed as a field on the target.

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

The following three models define a CRM. `contact` and `deal` reference `company`; `company` exposes the reverse edges as `contacts` and `deals`. Identity, the reverse edges, display, and permissions are all declared in the models.

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
      "hq": {
        "kind": "ref",
        "to": "atom://address"
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
      },
      "contacts": {
        "role": "inverse",
        "of": "atom://contact.company"
      },
      "deals": {
        "role": "inverse",
        "of": "atom://deal.company"
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
        "email",
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
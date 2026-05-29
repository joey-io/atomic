# Atomic

Atomic stores typed records and the schemas that define them as one kind of record: an atom. Relationships are typed edges. Indexes, permissions, rendering, and migrations are declared as atoms and executed by one kernel. Target use: graph-relational, queryable stores such as CRM.

## Primitives

Six. Uniqueness, identity, dedup, inverse edges, embedding, dashboards, audit, and time-travel are roles of these or sugar over them.

1. **Atom** — `{ id, model, manifest, attr, lifecycle }`. The record shape.
1. **Model** — a type definition. A trait is a model with `behavior.embedded`.
1. **Index** — access and constraint. `filter`, `sort`, `unique`, `identity`, `inverse` are roles.
1. **Path** — the expression language for filters, rules, display, migrations, exports.
1. **Logic** — a declarative spec the kernel evaluates, or a handler. Rules, hooks, and custom migrations use it. Handlers are the only code.
1. **Log** — append-only history. Provenance, audit, and time-travel are reads of it.

## Atom

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

|Field      |Definition                                                                                      |
|-----------|------------------------------------------------------------------------------------------------|
|`id`       |Flat, opaque, immutable address. Route: `atom://id`. Not derived from data.                     |
|`model`    |The model atom defining schema, edges, display, and rules.                                      |
|`manifest` |Prose. Caller-owned, CRUD-settable, full-text indexed.                                          |
|`attr`     |Model-shaped values. `ref` fields are edges.                                                    |
|`lifecycle`|Kernel-owned: `status`, `version` (write count), `modelVersion`, created/updated actor and time.|

`id` is a surrogate key; it stays opaque and immutable so edges survive data changes. Identity is a separate index role. Domain timestamps (`closedAt`) go in `attr`; `lifecycle` is operational.

## Model

A model atom defines a type’s fields, indexes, display, rules, and behavior. The kernel is self-describing: `model`, `index`, `hook`, `migration`, `token`, `config`, `file`, `log`, `plugin`, `tenant` are model atoms.

```json
{
  "id": "model",
  "model": "atom://model",
  "manifest": "Defines a type: fields, indexes, display, rules",
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

Field kinds: scalars (`text`, `longtext`, `integer`, `number`, `boolean`, `datetime`, `enum`); `ref` (typed pointer to a model); containers (`list`, `map`, `json`); modifiers (`required`, `default`, `unique`, `filterable`, `sortable`).

A `ref` resolves in one lookup. Its meaning is set by its target: a ref to a standalone model is a graph edge; a ref to an embedded model inlines the value.

A model with `behavior.embedded` has no standalone instances. Referencing it inlines its fields, which carry no `id` or `lifecycle`.

```json
{
  "id": "address",
  "model": "atom://model",
  "manifest": "Embedded model (a trait)",
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

`ref` fields are edges. An edge declares `to` and optional `inverse`. The kernel registers the inverse as an index on the target and maintains it on write, so both directions are queryable.

```txt
company → contacts → company        (edge and inverse)
contact → company → owner → team
deal → company → deals → deal        (cycle)
```

One path language reads through edges and nested JSON, used by filters, indexes, rules, display, and exports:

```txt
deal.company.owner.team
```

Traversal: refs may be cyclic; traversals terminate by cycle detection (visited-set), not a depth cap; each runs under a budget (wall-clock, nodes, result size) callers may raise; dangling refs error; resolved edges are cached and invalidated on mutation.

## Index

An index declares `over`, `params`, `match`, `sort`, `returns`, and a `role`:

- `filter` / `sort` — parameterized query over a model.
- `unique` — rejects a write that duplicates the key.
- `identity` — a unique index checked at create for dedup.
- `inverse` — the back-edge of a `ref`, exposed as a field on the target.

Field-level `unique` and `inverse` desugar to indexes. A standalone index is invoked as a reference: `atom://openDeals?company=atom://northwind`.

```json
{
  "id": "openDeals",
  "model": "atom://index",
  "manifest": "Open deals for a company, by value",
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

`display` declares `row`, `detail`, and `board` layouts; the kernel renders any atom or index from them. A dashboard is a set of saved indexes and `display` declarations.

## Correctness

Four rules.

Identity: on create the kernel looks up the `identity` indexes; a match is upserted (merged per `behavior.merge`), not inserted. `id` is not used for matching. Addressing is `surrogate` by default; `addressing: content` (id = hash of identity) is permitted only for immutable, single-keyed models.

Concurrency: a write includes the `lifecycle.version` it read. The kernel commits only if the stored version is unchanged, else returns a conflict. Last-writer-wins is opt-in per model.

Provenance: the log records each mutation at field granularity — actor, time, before, after. A value’s origin and history are the log entries for its field. Audit and time-travel read the same log. Computed-on-read values are not stored; audited or billed values are written, so they are indexed, logged, and fixed at write time.

Permissions: `rules` are `read` and `write` path predicates. Evaluation is fail-closed — false, error, or budget exhaustion denies. Permission traversal cannot fail open.

## Schema evolution

Models carry `version`. Additive or derivable changes do not bump it; existing atoms stay valid. A breaking change bumps `version` and ships a `migration` atom: immutable, forward-only. Each atom stores `modelVersion`. The kernel chains migrations on read, persists on the next write (copy-on-write), and runs a background sweep over atoms behind current. `op: rename` and `op: default` execute from `spec`; `op: custom` runs a handler. A field is complete only after the sweep; sweep before filtering, searching, or billing on it.

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

Three model atoms wired by `ref`/`inverse` edges. The graph, queries, rendering, dedup, log, and permissions are derived from them.

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
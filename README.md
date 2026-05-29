# Atomic

A substrate for building graph-relational, queryable databases. Schema is data, relationships are first-class edges, every surface is generated from atoms, and correctness comes first: identity, provenance, and permissions are guarantees of the kernel, not features of the app.

Everything is an atom.

```
{ id, model, manifest, attr, lifecycle }
```

## The atom

```json
{
  "id": "7b8f-...",
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

|Field      |Meaning                                                                                                                 |
|-----------|------------------------------------------------------------------------------------------------------------------------|
|`id`       |Flat, opaque, stable address. The route: `atom://id`. Never derived from data, never changes.                           |
|`model`    |The model atom defining this atom’s schema, relationships, display, and rules.                                          |
|`manifest` |Prose description, human- and agent-readable. Caller-owned, CRUD-settable, full-text searchable.                        |
|`attr`     |Model-shaped values, including `ref` fields that are edges in the graph.                                                |
|`lifecycle`|Kernel-owned: `status`, `version` (write count, used for concurrency), `modelVersion`, and created/updated actor + time.|

`id` is a surrogate key and stays flat and opaque so references never break when data changes. *Identity* — how two records are recognized as the same real-world thing — is a separate, model-defined natural key (see Correctness). Real-world timestamps (`closedAt`, `signedAt`) live in `attr`; `lifecycle` is operational only.

## Models

A model is an atom that defines a type: its fields, identity, display, permissions, and behavior. Adding a type is creating a model atom — no code, no deploy. The kernel is self-describing: `model`, `trait`, `index`, `hook`, `token`, `config`, `file`, `log`, `migration`, `plugin`, and `tenant` are all model atoms, defined the same way as the types you add.

```json
{
  "id": "model",
  "model": "atom://model",
  "manifest": "Defines atom schemas, relationships, display, and behavior",
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
      "identity": {
        "kind": "json"
      },
      "display": {
        "kind": "json"
      },
      "permissions": {
        "kind": "json"
      },
      "behavior": {
        "kind": "json"
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
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

### Field kinds

A field definition declares a `kind` and optional modifiers:

- scalars — `text`, `longtext`, `integer`, `number`, `boolean`, `datetime`, `enum` (`values`)
- `ref` — an edge to another atom. Declares `to` (target model) and optional `inverse` (the back-edge field maintained automatically on the target). This is what makes the data graph-relational.
- containers — `list` (`of`), `map`, `json`
- modifiers — `required`, `default`, `unique`, `filterable`, `sortable`

A `ref` is always a cheap, typed pointer. A *query* is always an index invoked by name (next section). The two are never confused, so reading a field’s kind tells you its cost.

## The graph

References use `atom://` and are first-class edges. Because a `ref` declares `to` and `inverse`, the graph is bidirectional and cheap to walk both ways: from a contact to its company, and from a company to its contacts, with no manual back-pointer.

```txt
company → contacts → company        (inverse pair)
contact → company → owner → team
deal → company → deals → deal        (cycle — valid)
```

Traversal paths read through edges and nested JSON with one language, used by filters, indexes, permissions, display, and exports:

```txt
deal.company.owner.team
```

**Traversal rules**

- Refs may be cyclic. Traversals terminate by cycle detection (visited-set), never by a depth cap.
- Every traversal runs under an explicit resource budget — wall-clock, nodes, result size — with a default callers may raise.
- Dangling references error. No silent nulls.
- Resolved edges are cached and invalidated on mutation broadcast.

## Querying and generated surfaces

An **index** is the one query primitive: a named, reusable, parameterized access pattern over a model. It declares what it ranges `over`, its `params`, a `match`, a `sort`, and whether it `returns` a set or one atom.

```json
{
  "id": "dealsByStage",
  "model": "atom://index",
  "manifest": "Open deals for a company, by stage",
  "attr": {
    "label": "Deals by stage",
    "over": "atom://deal",
    "params": {
      "company": {
        "kind": "ref",
        "to": "atom://company"
      }
    },
    "match": {
      "company": "atom://params.company",
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

Indexes are invoked as references — `atom://dealsByStage?company=atom://northwind` — so a query is just an atom you can pin, share, or embed.

**Generated UI** reads two declarations and needs no per-screen code:

- a model’s `display` (`row` for tables, `detail` for records, `board` for grouped/kanban views) renders any atom of that type;
- an index renders any list, filter, or dashboard tile.

A dashboard is therefore a small set of saved indexes plus the models’ `display`. Building a new view is authoring atoms, not writing a frontend.

## Correctness

The four guarantees the kernel enforces. Each is a single rule over the envelope, not a subsystem.

**Identity and dedup.** A model’s `identity` lists natural keys (`[["email"]]`, `[["domain"],["name"]]`). On create, the kernel resolves identity first: a match becomes an upsert (merged per `behavior.merge`), not a duplicate. `id` is never reused for this — it stays an opaque surrogate. Addressing is `surrogate` by default; a model may opt into `addressing: "content"` only if it is immutable and single-keyed, in which case the id is a hash of its identity.

**Concurrency.** Every write carries the `lifecycle.version` it read. The kernel commits only if the stored version is unchanged; otherwise the write is rejected as a conflict for the caller to retry. No lost updates. A model may opt into last-writer-wins where conflicts are acceptable.

**Provenance.** The `log` is append-only and field-granular: every mutation records actor, time, and before/after. Any value’s origin and full history are reconstructable by replaying its field’s log — provenance is a property of the log, not extra bookkeeping. Derived (computed-on-read) values are display-only; anything audited or billed is stored at write so it is indexable, logged, and frozen in time.

**Permissions.** A model declares `read` and `write` predicates as traversal-path expressions (`actor.team == company.owner.team`). They are evaluated fail-closed: a predicate that is false, errors, or exhausts its budget denies access. Permission traversal cannot fail open. Permissions compose across edges using the same path language as everything else.

## Schema evolution

Models carry an integer `version`. Adding an optional or derivable field does not bump it; existing atoms stay valid. A breaking change — rename, retype, optional→required, remove, identity or merge change — bumps `version` and ships a `migration` atom, which is immutable and forward-only.

Each atom stores the `modelVersion` it was written under. The kernel migrates lazily: on read it chains migrations from the atom’s version to current and returns the current shape; on the atom’s next write it persists that shape (copy-on-write); a background sweep rewrites the cold tail until none remain. `op: "rename"` and `op: "default"` run from `spec` with no code; `op: "custom"` runs a registered handler — the only place deployed code is required.

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

A field that is filtered, searched, or billed on is trustworthy only after the sweep completes; sweep before querying on it.

## A model is just an atom

The CRM above is three model atoms — `company`, `contact`, `deal` — wired by `ref`/`inverse` edges, each with identity, display, and rules. That is the whole pattern: define atoms, and the graph, the queries, the UI, the dedup, the audit trail, and the permissions follow from them.

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
        "kind": "text",
        "unique": true
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
    "identity": {
      "keys": [
        [
          "domain"
        ],
        [
          "name"
        ]
      ]
    },
    "display": {
      "row": [
        "name",
        "tier"
      ],
      "detail": [
        "name",
        "domain",
        "tier",
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
        "kind": "text",
        "unique": true,
        "filterable": true
      },
      "company": {
        "kind": "ref",
        "to": "atom://company",
        "inverse": "contacts"
      }
    },
    "identity": {
      "keys": [
        [
          "email"
        ]
      ]
    },
    "display": {
      "row": [
        "name",
        "email",
        "company"
      ]
    },
    "permissions": {
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
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
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
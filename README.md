# Atomic

A substrate for building graph-relational, queryable databases — CRM and anything shaped like it. Schema is data, relationships are first-class edges, every surface is generated, and correctness is the kernel’s job: identity, provenance, and permissions are guarantees, not app code.

## Primitives

Atomic has six. Everything else — uniqueness, dedup, inverse edges, embedding, dashboards, audit, time-travel — is a *role* one of these plays or sugar over them.

1. **Atom** — `{ id, model, manifest, attr, lifecycle }`. The only record shape.
1. **Model** — defines a type. A *trait* is a model whose instances embed instead of standing alone (`behavior.embedded`).
1. **Index** — the only access and constraint. Filter, sort, `unique`, `identity`, and `inverse` are roles an index plays.
1. **Path** — the only expression language. Filters, rules, display, migrations, and exports all read it.
1. **Logic** — a declarative spec the kernel runs, or a handler when it can’t. Rules, hooks, and custom migrations share this shape; deployed code lives only in handlers.
1. **Log** — the only history. Provenance, audit, and time-travel are views of it.

## The atom

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

|Field      |Meaning                                                                                                             |
|-----------|--------------------------------------------------------------------------------------------------------------------|
|`id`       |Flat, opaque, stable address — the route `atom://id`. Never derived from data, never changes.                       |
|`model`    |The model atom defining schema, edges, display, and rules.                                                          |
|`manifest` |Prose, human- and agent-readable. Caller-owned, CRUD-settable, full-text searchable.                                |
|`attr`     |Model-shaped values; `ref` fields are edges in the graph.                                                           |
|`lifecycle`|Kernel-owned: `status`, `version` (write count, used for concurrency), `modelVersion`, created/updated actor + time.|

`id` is a surrogate and stays opaque so edges never break when data changes. Recognizing two records as the same real thing is *identity*, a separate index role. Real-world times (`closedAt`) live in `attr`; `lifecycle` is operational only.

## Models

A model is an atom defining a type. Adding a type is writing a model atom — no code, no deploy. The kernel is self-describing: `model`, `index`, `hook`, `migration`, `token`, `config`, `file`, `log`, `plugin`, `tenant` are model atoms, defined exactly as the types you add.

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

**Field kinds.** Scalars (`text`, `longtext`, `integer`, `number`, `boolean`, `datetime`, `enum`); `ref` (a typed pointer to a model); containers (`list`, `map`, `json`); modifiers (`required`, `default`, `unique`, `filterable`, `sortable`).

A `ref` is always a cheap typed pointer. What it *means* is decided by its target, not the field: a ref to a standalone model is a graph edge; a ref to an embedded model inlines the value. Composition and relationship are the same field.

**Traits are embedded models.** Mark a model `behavior.embedded` and its instances inline wherever referenced, carrying no id or lifecycle of their own — a reusable field shape, expressed as a model so there is one fewer concept.

```json
{
  "id": "address",
  "model": "atom://model",
  "manifest": "A postal address \u2014 an embedded model (a trait)",
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

## The graph

`ref` fields are edges. An edge declares `to` and optional `inverse`; the kernel registers the inverse as an index on the target, so the back-edge is a queryable field maintained automatically. The graph is bidirectional with no manual back-pointers.

```txt
company → contacts → company        (an edge and its inverse)
contact → company → owner → team
deal → company → deals → deal        (a cycle — valid)
```

One path language reads through edges and nested JSON, used by filters, indexes, rules, display, and exports:

```txt
deal.company.owner.team
```

**Traversal:** refs may be cyclic; traversals terminate by cycle detection, never a depth cap; every traversal runs under an explicit budget (time, nodes, result size) callers may raise; dangling refs error — no silent nulls; resolved edges are cached and invalidated on mutation.

## Indexes, queries, and generated UI

An index is the single access-and-constraint primitive. The same declaration that answers a query also enforces a constraint, depending on its `role`:

- *filter / sort* — a reusable, parameterized query over a model.
- *unique* — rejects a write that would duplicate the key.
- *identity* — a unique index used at create for dedup (below).
- *inverse* — the back-edge of a `ref`, surfaced as a field on the target.

Field-level `unique` and `inverse` are sugar; they desugar to indexes. A standalone index is invoked as a reference — `atom://openDeals?company=atom://northwind` — so a query is an atom you can pin, share, or embed.

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

**Generated UI** needs no per-screen code: a model’s `display` (`row`, `detail`, `board`) renders any atom of that type, and an index renders any list or tile. A dashboard is saved indexes plus `display`. Building a view is authoring atoms.

## Correctness

Each guarantee is one rule over the primitives — not a subsystem.

**Identity / dedup.** Indexes with `role: identity` are the natural keys. On create the kernel resolves them first: a match upserts (merged per `behavior.merge`) instead of duplicating. `id` is never reused for this. Addressing is `surrogate` by default; a model may set `addressing: content` only if immutable and single-keyed.

**Concurrency.** Every write carries the `lifecycle.version` it read; the kernel commits only if the stored version is unchanged, else rejects as a conflict to retry. No lost updates. Last-writer-wins is opt-in per model.

**Provenance.** The log is append-only and field-granular. Any value’s origin and history replay from its field’s log; audit and time-travel are the same data read differently. Computed-on-read values are display-only; anything audited or billed is stored at write — indexable, logged, frozen.

**Permissions.** A model’s `rules` are `read`/`write` path predicates (`actor.team == company.owner.team`), evaluated fail-closed: false, error, or budget-exhausted all deny. Permission traversal cannot fail open. Rules, hooks, and custom migrations are the one Logic shape; code, when needed, is a registered handler.

## Schema evolution

Models carry `version`. Additive or derivable changes do not bump it; existing atoms stay valid. A breaking change bumps `version` and ships an immutable, forward-only `migration`. Each atom stores its `modelVersion`; the kernel migrates lazily — chained on read, persisted on next write (copy-on-write), and a background sweep clears the cold tail. `op: rename` / `op: default` run from `spec` with no code; `op: custom` is the one Logic handler. Sweep a field to completion before filtering, searching, or billing on it.

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

## A model is just an atom

This CRM is three model atoms wired by `ref`/`inverse` edges. From them the kernel derives the graph, the queries, the UI, the dedup, the audit trail, and the permissions. Nothing else is authored.

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
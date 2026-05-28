# Atomic

A framework for building data systems. Everything is an atom — models, traits, indexes, hooks, config, tokens, and attributes.

```
{ id, model, attr, lifecycle }
```

Atomic ships these atoms:

```json
{
  "id": "0",
  "model": "atom://tenant",
  "attr": {
    "name": "Atomic",
    "version": "0.1.0"
  },
  "lifecycle": {
    "status": "active",
    "version": 1,
    "createdAt": "2026-05-28T00:00:00Z",
    "createdBy": "0"
  }
}
```

```json
{
  "id": "model",
  "model": "atom://model",
  "attr": {
    "purpose": "Defines atom schemas and behavior"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "trait",
  "model": "atom://model",
  "attr": {
    "purpose": "Reusable field shapes"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "index",
  "model": "atom://model",
  "attr": {
    "purpose": "Reusable access pattern and physical index intent"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "plugin",
  "model": "atom://model",
  "attr": {
    "purpose": "Bundle of atoms (models, indexes, hooks, config)"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "tenant",
  "model": "atom://model",
  "attr": {
    "purpose": "Defines active plugins, config, and capabilities"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "hook",
  "model": "atom://model",
  "attr": {
    "purpose": "Pipeline logic"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "token",
  "model": "atom://model",
  "attr": {
    "purpose": "Authentication"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "config",
  "model": "atom://model",
  "attr": {
    "purpose": "Cascading settings"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "file",
  "model": "atom://model",
  "attr": {
    "purpose": "Object storage pointers"
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "log",
  "model": "atom://model",
  "attr": {
    "purpose": "Append-only audit entries"
  },
  "lifecycle": "atom://0"
}
```

---

## Principles

```
1. Models define behavior, indexes define access, logs capture mutations
2. One kernel, one pipeline — all surfaces are generated from atoms
```

---

## The Atom

```json
{
  "id": "invoice-2026-000001",
  "model": "atom://invoice",
  "attr": {},
  "lifecycle": {
    "status": "active",
    "version": 1,
    "createdAt": "2026-05-28T12:00:00Z",
    "createdBy": "actor-id",
    "updatedAt": "2026-05-28T12:00:00Z",
    "updatedBy": "actor-id"
  }
}
```

| Field | Purpose |
|-------|---------|
| `id` | Unique identity. Caller-assigned or system-generated GUID. Must be unique within the workspace. |
| `model` | Points to the model atom defining schema and behavior. |
| `attr` | Attributes shaped by the model. |
| `lifecycle` | Kernel-managed operational metadata. |

IDs may be human-readable (`invoice-2026-000001`) or GUIDs (`7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11`). No dots — the atom ID is the route. Do not rely on ID shape for deduplication, permissions, validation, or behavior — identity is model-defined.

Real-world timestamps (`occurredAt`, `effectiveAt`, `filedAt`) belong in `attr`.

---

## References

All references use `atom://`.

```
atom://id
atom://id?param=value
```

The system resolves what the target atom is. If it's an index, it executes. If it's a direct atom, it resolves directly.

Examples:

```
atom://invoice
atom://officialsByDistrict?state=MD&district=5
atom://modelsByKey?key=invoice
```

Indexes return sets by default. An index can be constrained to return one atom with `limit: 1` or `returns: "one"`.

Indexes are used when the target set must be resolved through reusable access logic:

- imports
- templates
- config
- portable manifests
- human-authored definitions
- identity resolution
- relationship resolution
- generated lists
- dashboards
- reports

Traversal paths resolve through references and nested JSON:

```txt
contribution.committee.treasurer.address.state
```

The same traversal language works across:

- filters
- indexes
- GraphQL
- permissions
- hooks
- exports
- generated UI

---

## Traits

A trait is a reusable field shape.

```json
{
  "id": "address",
  "model": "atom://trait",
  "attr": {
    "fields": {
      "street": {
        "kind": "text"
      },
      "city": {
        "kind": "text"
      },
      "state": {
        "kind": "text"
      },
      "zip": {
        "kind": "text"
      },
      "country": {
        "kind": "text",
        "default": "US"
      }
    }
  }
}
```

Traits are schema includes — not separate atoms.

An address is usually embedded JSON, not its own atom.

Models reference traits:

```json
{
  "location": "atom://address"
}
```

---

## Models

A model defines:

- fields
- validation
- display
- permissions
- identity
- merge rules
- retention
- hooks
- indexes
- generated surfaces

Example:

```json
{
  "id": "facility",
  "model": "atom://model",
  "attr": {
    "label": "Facility",
    "fields": {
      "name": {
        "kind": "text",
        "required": true
      },
      "location": "atom://address",
      "openedAt": {
        "kind": "datetime",
        "filterable": true,
        "sortable": true
      }
    },
    "identity": {
      "keys": [
        ["externalIds.fec"],
        ["name", "location.city", "location.state"]
      ]
    },
    "display": {
      "row": ["name", "location.city"]
    },
    "behavior": {
      "mutable": true,
      "mergeStrategy": "model-defined"
    }
  }
}
```

Adding a new type means creating a model atom. No code changes. No deployment.

### Type Compatibility

`type` is not the primary classifier. The model reference is canonical.

`type` may remain as a denormalized accelerator:

```json
{
  "type": "invoice"
}
```

It is derived from the resolved model. Optional cache/index metadata.

---

## Identity & Deduplication

Identity is model-defined.

Atomic never infers sameness from atom IDs.

Models define identity key sets:

```json
{
  "identity": {
    "keys": [
      ["externalIds.fec"],
      ["email"],
      ["name", "birthDate"]
    ]
  }
}
```

During writes/imports:

```txt
resolve model
  → validate
  → resolve identity
  → deduplicate / merge
  → execute
```

Possible outcomes:

| Result | Behavior |
|---|---|
| no match | create atom |
| confident match | merge/update |
| ambiguous | create review task |

---

## Merging

```txt
A + B → A
```

Where:

- `A` becomes canonical
- refs to `B` resolve to `A`
- merge history remains queryable
- merge operations produce log atoms

---

## Indexes

Indexes are atoms.

An index defines reusable access logic and physical indexing intent:

- lists
- detail lookups
- pivots
- aggregations
- relationship resolvers
- reference resolvers
- search definitions
- materialized views
- derived dashboards
- physical index plans

Indexes return sets of atoms by default.

An index can be constrained to return one atom with `limit: 1` or `returns: "one"`.

Example: invoices by quarter.

```json
{
  "id": "invoicesByQuarter",
  "model": "atom://index",
  "attr": {
    "source": "atom://invoice",
    "where": {
      "issuedAt": {
        "between": ["{{start}}", "{{end}}"]
      }
    },
    "groupBy": ["issuedAt.quarter"],
    "measures": [
      {
        "field": "amountCents",
        "op": "sum",
        "as": "totalCents"
      }
    ],
    "returns": "many",
    "physical": {
      "paths": [
        "issuedAt",
        "amountCents"
      ],
      "strategy": "materialize-when-expensive"
    }
  }
}
```

Example: model lookup by key.

```json
{
  "id": "modelsByKey",
  "model": "atom://index",
  "attr": {
    "source": "atom://model",
    "where": {
      "key": "{{key}}"
    },
    "limit": 1,
    "returns": "one",
    "physical": {
      "unique": ["key"],
      "paths": ["key"],
      "strategy": "btree"
    }
  }
}
```

Then a caller references the index:

```
atom://invoicesByQuarter?start=2026-01-01&end=2026-03-31
atom://modelsByKey?key=invoice
```

### Physical Indexing

The global `index` model defines how index atoms express physical indexing intent.

Physical indexing is derived from index atoms.

An index can declare:

| Attribute | Purpose |
|---|---|
| `physical.paths` | JSON paths repeatedly filtered, sorted, grouped, joined, or traversed |
| `physical.unique` | paths that should be unique for the index source |
| `physical.strategy` | preferred physical strategy: `btree`, `gin`, `trigram`, `vector`, `materialized`, or `auto` |
| `physical.materialize` | whether results should be persisted/rebuilt |
| `physical.refresh` | refresh policy for materialized index results |
| `physical.derivedEdges` | ref paths worth projecting into graph accelerators |

Example:

```json
{
  "physical": {
    "paths": [
      "contributor",
      "committee",
      "electionCycle",
      "amountCents",
      "receivedAt"
    ],
    "unique": [
      "externalIds.fecTransactionId"
    ],
    "strategy": "auto",
    "materialize": false,
    "derivedEdges": [
      "contributor",
      "committee"
    ]
  }
}
```

Atomic may create derived accelerators from index intent:

- btree indexes
- GIN indexes
- generated columns
- trigram search indexes
- vector indexes
- materialized index tables
- graph edge tables

All accelerators are derived. All are rebuildable. None are source-of-truth.

---

## Kernel

The kernel is the only hand-maintained runtime layer. It contains no model-specific logic.

The kernel knows how to:

- authenticate
- resolve tenants and workspaces
- load atoms
- resolve refs
- execute indexes
- resolve models
- validate attrs
- apply permissions
- deduplicate and merge
- run hooks
- write logs
- broadcast changes
- derive physical accelerators
- render generated surfaces

Everything else is schema (atoms).

---

## Generated Surfaces

All surfaces are generated from the same kernel pipeline.

| Surface | Generated From |
|---|---|
| API | models, indexes, permissions |
| Web UI | models, indexes, display config |
| MCP | models, indexes, descriptions |
| Documentation | models, indexes, fields, examples |
| Imports / Exports | models, traits, permissions |

Change a model → all surfaces update.
Change an index → all surfaces update.

---

## Plugins

Plugins bundle:

- models
- indexes
- hooks
- config

Activation makes capabilities appear.

Deactivation removes capabilities while preserving data.

---

## The Interface

Single pipeline for all operations:

```txt
request
  → authenticate
  → resolve tenant/workspace
  → resolve refs and indexes
  → resolve model
  → resolve config
  → validate
  → resolve identity
  → deduplicate / merge
  → plan index / accelerators
  → run hooks
  → execute
  → write logs
  → enqueue async hooks
  → broadcast
  → respond
```

All data enters and leaves through this pipeline.

---

## Routes

Routes are generic — not created per model or feature.

```txt
/app
/api/atoms
/api/indexes/:id
/api/graphql
/api/docs
/api/mcp
```

### REST

`/api/indexes/invoicesByQuarter?start=2026-01-01&end=2026-03-31` executes the `invoicesByQuarter` index atom. Documentation, permissions, and validation are derived from the same atom.

### GraphQL

Generated from indexes and models. Each index becomes a query field. Params become arguments. Traversal paths become nested selections.

```graphql
query {
  officialsByDistrict(state: "MD", district: "5") {
    id
    attr {
      name
      committee {
        treasurer {
          address {
            state
          }
        }
      }
    }
  }
}
```

This is the same as:

```
atom://officialsByDistrict?state=MD&district=5
```

The GraphQL schema is not hand-maintained. It is derived from model fields, index definitions, and permissions.

---

## Hooks

Hooks are atoms executed during pipeline phases.

| Phase | Purpose |
|---|---|
| `pre:save` | validate/transform |
| `pre:read` | scope/filter |
| `post:save` | workflows/notifications |
| `post:read` | redaction/computed fields |

Async hooks enqueue transactionally.

---

## Hierarchy

```txt
System
  └─ Tenant
       └─ Workspace
            └─ Database
```

Each workspace is a separate database. No shared tenant tables.

---

## Config

Config resolves:

```txt
workspace → tenant → system
```

First match wins.

Config atoms define:

- scope
- key
- value

---

## Auth

Authentication:

```txt
request
  → hash token
  → lookup token atom
  → load actor
  → merge roles
  → check permissions
```

No passwords. No OAuth. No JWT requirement.

---

## Lifecycle

Kernel-managed. Same shape for all atoms. Callers do not write to it.

```json
{
  "lifecycle": {
    "status": "active",
    "version": 3,
    "createdAt": "2026-01-15T09:00:00Z",
    "createdBy": "actor-id",
    "updatedAt": "2026-05-28T14:30:00Z",
    "updatedBy": "actor-id"
  }
}
```

| Field | Values |
|---|---|
| `status` | `active`, `archived`, `deleted` |
| `version` | Incremented on each mutation |
| `createdAt` | Set once on creation |
| `createdBy` | Actor who created |
| `updatedAt` | Set on each mutation |
| `updatedBy` | Actor who last mutated |

Lifecycle can be a reference. The system resolves it like any other field:

```json
{
  "lifecycle": "atom://0"
}
```

This inherits lifecycle from the referenced atom. When atom 0 is updated, all atoms referencing it reflect the change.

Immutable atoms use corrections/reversals instead of updates.

---

## Logs

Every mutation produces append-only log atoms.

Creation is represented by the atom itself.

Mutations produce log atoms:

```txt
create → atom exists
update → log atom
merge → log atom
archive → log atom
restore → log atom
```

Logs contain:

- affected atom
- action
- before
- after
- actor
- timestamp
- source

Logs are queryable like all other atoms.

---

## Database

Each workspace database contains:

- atoms
- logs

Atoms:

```txt
id
model
attr JSONB
lifecycle JSONB
```

Logs:

```txt
id
atom_id
action
before JSONB
after JSONB
actor
occurred_at
```

Accelerators may be added:

- GIN indexes
- btree indexes
- generated columns
- trigram indexes
- vector indexes
- materialized indexes
- graph accelerators
- identity indexes

All accelerators are derived from models and indexes. Never source-of-truth.

---

## Stack

| Layer | Choice |
|---|---|
| Database | Postgres |
| App | Node.js + Next.js |
| Storage | S3-compatible |
| Email | Transactional provider |

Postgres handles:

- jobs
- realtime
- queues
- subscriptions
- search
- scheduling

No Redis. No Kafka. No external queue.

---

## Scaling

Architecture is unchanged at any scale.

The catalog maps:

```txt
workspace → database connection
```

---

## Import & Export

Schema-driven.

Models and indexes generate:

- templates
- validation
- previews
- import pipelines
- exports
- dashboards
- API documentation
- MCP tool definitions

Imports flow through the same interface pipeline.

Exports respect permissions.

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

-----

## Principles

```
1. Models define behavior, indexes define access, logs capture mutations
2. One kernel, one pipeline — all surfaces are generated from atoms
3. Refs may be cyclic; traversals terminate by cycle detection and are
   bounded by resource budget, not depth
```

-----

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

|Field      |Purpose                                                                                        |
|-----------|-----------------------------------------------------------------------------------------------|
|`id`       |Unique identity. Caller-assigned or system-generated GUID. Must be unique within the workspace.|
|`model`    |Points to the model atom defining schema and behavior.                                         |
|`attr`     |Attributes shaped by the model.                                                                |
|`lifecycle`|Kernel-managed operational metadata.                                                           |

IDs may be human-readable (`invoice-2026-000001`) or GUIDs (`7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11`). No dots — the atom ID is the route. Do not rely on ID shape for deduplication, permissions, validation, or behavior — identity is model-defined.

Real-world timestamps (`occurredAt`, `effectiveAt`, `filedAt`) belong in `attr`.

-----

## References

All references use `atom://`.

```
atom://id
atom://id?param=value
```

The system resolves what the target atom is. If it’s an index, it executes. If it’s a direct atom, it resolves directly.

References may be cyclic.

Examples:

```txt
person → company → boardMember → person
country → ally → country
bill → amendment → bill
```

Cycles are valid graph structures.

The kernel protects execution — not the graph itself.

### Resolution rules

- Self-reference terminates safely (e.g. `model` → `atom://model`)
- Cyclic refs are allowed
- Traversals terminate via cycle detection (visited-set), not depth limits
- Traversals are bounded by an explicit resource budget — wall-clock, nodes visited, result size — with a default budget callers may raise
- Dangling references error — no silent nulls
- Copy-on-write: first mutation to a referenced field detaches it into a local value
- Resolved references are cached — invalidated on mutation broadcast

Cycle detection guarantees termination; the resource budget guarantees bounded cost. Depth is neither — it is not a bound.

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

-----

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

-----

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
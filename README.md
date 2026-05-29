# Atomic

A framework for building data systems. Everything is an atom — models, traits, indexes, hooks, config, tokens, and attributes.

```
{ id, model, manifest, attr, lifecycle }
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
  "manifest": "Defines atom schemas and behavior",
  "attr": {
    "label": "Model",
    "fields": {
      "label": {
        "kind": "text"
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
      },
      "hooks": {
        "kind": "list",
        "of": "atom://hook"
      },
      "indexes": {
        "kind": "list",
        "of": "atom://index"
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
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "trait",
  "model": "atom://model",
  "manifest": "Reusable field shapes",
  "attr": {
    "label": "Trait",
    "fields": {
      "label": {
        "kind": "text"
      },
      "fields": {
        "kind": "map",
        "required": true
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "index",
  "model": "atom://model",
  "manifest": "Reusable access pattern and physical index intent",
  "attr": {
    "label": "Index",
    "fields": {
      "label": {
        "kind": "text"
      },
      "over": {
        "kind": "ref",
        "of": "atom://model",
        "required": true
      },
      "params": {
        "kind": "map"
      },
      "match": {
        "kind": "json"
      },
      "sort": {
        "kind": "list"
      },
      "returns": {
        "kind": "enum",
        "values": [
          "set",
          "one"
        ],
        "default": "set"
      },
      "limit": {
        "kind": "integer"
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "plugin",
  "model": "atom://model",
  "manifest": "Bundle of atoms (models, indexes, hooks, config)",
  "attr": {
    "label": "Plugin",
    "fields": {
      "label": {
        "kind": "text"
      },
      "version": {
        "kind": "text",
        "required": true
      },
      "provides": {
        "kind": "list",
        "of": "ref",
        "required": true
      },
      "requires": {
        "kind": "list",
        "of": "atom://plugin"
      },
      "config": {
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
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "tenant",
  "model": "atom://model",
  "manifest": "Defines active plugins, config, and capabilities",
  "attr": {
    "label": "Tenant",
    "fields": {
      "name": {
        "kind": "text",
        "required": true
      },
      "version": {
        "kind": "text"
      },
      "plugins": {
        "kind": "list",
        "of": "atom://plugin"
      },
      "config": {
        "kind": "json"
      },
      "capabilities": {
        "kind": "list",
        "of": "text"
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
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
  "id": "hook",
  "model": "atom://model",
  "manifest": "Pipeline logic",
  "attr": {
    "label": "Hook",
    "fields": {
      "label": {
        "kind": "text"
      },
      "on": {
        "kind": "enum",
        "values": [
          "beforeValidate",
          "beforeWrite",
          "afterWrite",
          "beforeRead",
          "afterRead"
        ],
        "required": true
      },
      "model": {
        "kind": "ref",
        "of": "atom://model"
      },
      "run": {
        "kind": "text",
        "required": true
      },
      "order": {
        "kind": "integer",
        "default": 0
      },
      "enabled": {
        "kind": "boolean",
        "default": true
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "token",
  "model": "atom://model",
  "manifest": "Authentication",
  "attr": {
    "label": "Token",
    "fields": {
      "label": {
        "kind": "text"
      },
      "subject": {
        "kind": "ref",
        "required": true
      },
      "scopes": {
        "kind": "list",
        "of": "text"
      },
      "hash": {
        "kind": "text",
        "required": true
      },
      "expiresAt": {
        "kind": "datetime",
        "filterable": true
      },
      "lastUsedAt": {
        "kind": "datetime"
      },
      "revoked": {
        "kind": "boolean",
        "default": false
      }
    },
    "identity": {
      "keys": [
        [
          "id"
        ]
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "config",
  "model": "atom://model",
  "manifest": "Cascading settings",
  "attr": {
    "label": "Config",
    "fields": {
      "label": {
        "kind": "text"
      },
      "scope": {
        "kind": "enum",
        "values": [
          "tenant",
          "plugin",
          "model",
          "atom"
        ],
        "required": true
      },
      "target": {
        "kind": "ref"
      },
      "values": {
        "kind": "json",
        "required": true
      },
      "order": {
        "kind": "integer",
        "default": 0
      }
    },
    "identity": {
      "keys": [
        [
          "scope",
          "target"
        ]
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
  "id": "file",
  "model": "atom://model",
  "manifest": "Object storage pointers",
  "attr": {
    "label": "File",
    "fields": {
      "label": {
        "kind": "text"
      },
      "key": {
        "kind": "text",
        "required": true
      },
      "bucket": {
        "kind": "text"
      },
      "contentType": {
        "kind": "text"
      },
      "size": {
        "kind": "integer"
      },
      "checksum": {
        "kind": "text"
      }
    },
    "identity": {
      "keys": [
        [
          "bucket",
          "key"
        ]
      ]
    },
    "behavior": {
      "mutable": false,
      "merge": "replace"
    }
  },
  "lifecycle": "atom://0"
}
```

```json
{
  "id": "log",
  "model": "atom://model",
  "manifest": "Append-only audit entries",
  "attr": {
    "label": "Log",
    "fields": {
      "at": {
        "kind": "datetime",
        "required": true,
        "filterable": true,
        "sortable": true
      },
      "actor": {
        "kind": "ref"
      },
      "action": {
        "kind": "enum",
        "values": [
          "create",
          "update",
          "delete",
          "read"
        ],
        "required": true
      },
      "target": {
        "kind": "ref",
        "required": true
      },
      "model": {
        "kind": "ref",
        "of": "atom://model"
      },
      "diff": {
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
    "behavior": {
      "mutable": false,
      "merge": "append"
    }
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

|Field      |Purpose                                                                                                                                                                       |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`id`       |Unique identity. Caller-assigned or system-generated GUID. Must be unique within the workspace.                                                                               |
|`model`    |Points to the model atom defining schema and behavior.                                                                                                                        |
|`manifest` |Prose description of the atom, human- and agent-readable. Caller-owned: created and updated through CRUD like any field, and full-text searchable. Not validated by the model.|
|`attr`     |Attributes shaped by the model.                                                                                                                                               |
|`lifecycle`|Kernel-managed operational metadata.                                                                                                                                          |

IDs may be human-readable (`invoice-2026-000001`) or GUIDs (`7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11`). No dots — the atom ID is the route. Do not rely on ID shape for deduplication, permissions, validation, or behavior — identity is model-defined.

Real-world timestamps (`occurredAt`, `effectiveAt`, `filedAt`) belong in `attr`.

`manifest` is plain prose — a description of what the atom is for, readable by people and agents. It is caller-owned: written and changed through ordinary create and update operations, not kernel-managed like `lifecycle`. The kernel maintains a full-text index over every atom’s `manifest`, so it is searchable without any model declaring it. `manifest` resolves as a path in the traversal language — usable in filters, indexes, and permissions — and supports text-match against the index.

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
atom://search?manifest=data+center
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

A trait is a first-class atom that defines a reusable field shape.

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

When a model references a trait, the kernel resolves it and inlines its fields at schema-compile time. The resolved value is stored as embedded JSON on the host atom — the trait atom is the definition, the embedded fields are its expansion.

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

### Field definitions

Each entry in a model’s `fields` map is a field definition:

- `kind` — `text`, `longtext`, `integer`, `number`, `boolean`, `datetime`, `enum`, `ref`, `list`, `map`, or `json`
- `required` — must be present (default `false`)
- `default` — value used when the field is absent
- `filterable` / `sortable` — exposed to indexes and queries
- `unique` — enforced within the model
- `of` — element constraint: a `kind` for `list`, or an `atom://model` target for a `ref` (or a list of refs)
- `values` — allowed values for `enum`

`json` is an open sub-object validated by hooks rather than by shape. `map` is a keyed collection whose values follow the same field-definition form (this is how `fields` itself is typed).

### Example

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
        [
          "externalIds.fec"
        ],
        [
          "name",
          "location.city",
          "location.state"
        ]
      ]
    },
    "display": {
      "row": [
        "name",
        "location.city"
      ]
    },
    "behavior": {
      "mutable": true,
      "merge": "model-defined"
    }
  }
}
```

Adding a new type means creating a model atom. No code changes. No deployment.
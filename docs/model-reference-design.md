# Model Reference Architecture

Atomic no longer treats `type` as the primary classifier.

Instead, every atom references a model.

A model reference can be direct:

```json
{
  "guid": "7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11",
  "model": {
    "$ref": "22222222-2222-4222-8222-222222222222"
  },
  "attr": {},
  "lifecycle": {}
}
```

Or query-resolved:

```json
{
  "guid": "7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11",
  "model": {
    "$lookup": {
      "model": {
        "$lookup": {
          "key": "model"
        }
      },
      "where": {
        "key": "invoice"
      }
    }
  },
  "attr": {},
  "lifecycle": {}
}
```

## Reference Forms

Atomic supports two reference forms.

| Form | Purpose |
|---|---|
| `$ref` | Direct reference to a known atom GUID |
| `$lookup` | Query-resolved reference to an atom matching model-defined criteria |

### Direct Reference

Use `$ref` when the target atom GUID is already known.

```json
{
  "model": {
    "$ref": "22222222-2222-4222-8222-222222222222"
  }
}
```

This is the fastest and most explicit form.

### Lookup Reference

Use `$lookup` when the target should be resolved by query.

```json
{
  "model": {
    "$lookup": {
      "model": {
        "$lookup": {
          "key": "model"
        }
      },
      "where": {
        "key": "invoice"
      }
    }
  }
}
```

This says:

```txt
Find the atom whose model is model, where key is invoice.
```

The interface resolves the lookup to a GUID before validation and execution.

Lookups are useful for:

- imports
- templates
- config
- plugin manifests
- cross-environment portability
- human-authored definitions

The system may cache lookup resolution, but the canonical reference is still the resolved atom GUID.

## Why

`type` eventually becomes a duplicate abstraction.

The real source of meaning is the model itself.

The system always resolves:

- validation
- display
- permissions
- indexes
- retention
- merge rules
- identity rules
- hooks
- generated UI
- GraphQL schema
- MCP tools

from the model.

So instead of:

```json
{
  "type": "invoice"
}
```

Atomic moves toward:

```json
{
  "model": {
    "$ref": "22222222-2222-4222-8222-222222222222"
  }
}
```

or:

```json
{
  "model": {
    "$lookup": {
      "model": {
        "$lookup": {
          "key": "model"
        }
      },
      "where": {
        "key": "invoice"
      }
    }
  }
}
```

This keeps the system fully self-describing.

## Resolution

The interface resolves the model before all operations.

```txt
request
  → resolve model reference
  → resolve lookup refs
  → validate
  → resolve identity
  → deduplicate / merge
  → execute
```

The resolved model becomes the execution contract.

## Human Keys vs GUIDs

Models still have GUIDs internally.

But humans usually reference them through stable semantic keys:

```json
{
  "key": "invoice"
}
```

This creates a separation between:

| Concept | Purpose |
|---|---|
| `guid` | stable internal identity |
| `key` | human-readable lookup identifier |

## Traversal

Traversal becomes model-driven instead of type-driven.

```txt
contribution.committee.treasurer.address.state
```

The interface resolves:

```txt
field
  → model
    → field
      → model
```

This effectively creates:

- document traversal
- relational joins
- graph traversal

through one semantic execution system.

## Backwards Compatibility

`type` can remain as a denormalized accelerator:

```json
{
  "type": "invoice"
}
```

But it is derived from the resolved model.

The model reference is canonical.
The type string is optional cache/index metadata.

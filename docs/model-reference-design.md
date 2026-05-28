# Model Reference Architecture

Atomic no longer treats `type` as the primary classifier.

Instead, every atom references a model.

```json
{
  "guid": "7b8f2f0c-5f0f-4a3d-9f0d-2d6e2d4d1c11",
  "model": {
    "$lookup": {
      "type": "model",
      "where": {
        "key": "invoice"
      }
    }
  },
  "attr": {},
  "lifecycle": {}
}
```

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
  "model": { "$ref": "..." }
}
```

or:

```json
{
  "model": {
    "$lookup": {
      "type": "model",
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
  → resolve model
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

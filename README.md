# Atomic

> One record shape for everything — data, schema, identity, permissions, queries, the audit log, parsing, and folding.

Atomic is a zero-required-dependency Node.js data substrate. The single-file kernel (`atomic.mjs`) governs atoms, models, permissions, queries, lifecycle, storage, HTTP, and the generated UI. The package runtime adds model-driven observation and deterministic identity folding for turning unstructured inputs into a coherent canonical graph.

## Install

```bash
npm install atomic
```

Node.js 22.5 or newer is required.

## Package API

```js
import { createAtomic } from 'atomic';

const atomic = await createAtomic({
  models: ['@atomic/models-public-affairs'],
  modelDirectory: './atomic/models',
  provider
});

const preview = await atomic.observe(input);
const result = await atomic.parse(input);
```

Atomic ships with `person`, `place`, `thing`, and `event` definitions. Load order is deterministic:

1. built-in core definitions
2. installed model packs
3. project-local definitions from `atomic/models`
4. runtime definitions

Later definitions override earlier ones.

### Observation and folding

`observe()` proposes evidence-backed candidates without changing canonical data. `parse()` applies confidence policy and folds accepted candidates into the canonical graph.

```text
input -> provider -> candidates -> confidence gate -> fold -> create | merge | review
```

The fold engine is deterministic and model-driven. Packs define identity keys, exclusive identifiers, contradiction penalties, thresholds, normalizers, and field merge policies. Atomic preserves immutable observations and field-level assertions, records merge events, and supports reversible manual merges.

```js
const decision = await atomic.resolve(candidate);
const folded = await atomic.fold(candidate);
await atomic.merge(sourceId, targetId);
await atomic.split(mergeId);
```

See [model packs](docs/model-packs.md), [parser architecture](docs/architecture-parser.md), and [identity folding](docs/folding.md).

## Kernel quick start

```bash
npm start
ATOMIC_STORE=./data npm start
ATOMIC_DB=postgres://localhost/atomic npm start
npm test
npm run check
npm run audit
```

Every stored record has one shape:

```json
{ "id": "...", "model": "atom://...", "manifest": "...", "attr": {}, "lifecycle": {} }
```

The kernel derives validation, REST endpoints, CSV import/export, permissions, queries, audit logging, tenancy, lifecycle, and the HTML UI from model atoms. Storage is pluggable: memory, SQLite through `node:sqlite`, or Postgres through the optional `pg` dependency.

## Core properties

- **One shape:** data, schemas, permissions, queries, logs, migrations, policies, and tests are atoms.
- **Model-driven:** schemas and behavior are data, not generated code.
- **Evidence-backed:** parser output retains source evidence and confidence.
- **Deterministic identity:** normalized keys and explicit contradictions govern deduplication.
- **Reversible folding:** source observations are never destroyed by a merge.
- **Tenant-aware:** visibility and writes follow the `lifecycle.parent` tree.
- **Field-level authorization:** grants and sensitivity rules apply per field.
- **Transactional:** writes, cascades, logs, and governance changes are atomic.
- **Locked mode:** purpose-bound sensitive reads, governed changes, break-glass, legal hold, and tamper-evident evidence.

## HTTP surface

| Method | Operation |
|---|---|
| `GET /<id>` | Read an atom |
| `GET /<model>` | List/filter/sort atoms |
| `POST /<model>` | Create atom(s) |
| `PATCH /<id>` | Merge-update with `If-Match` |
| `PUT /<id>` | Replace attributes with `If-Match` |
| `DELETE /<id>` | Soft-delete/retire |
| `POST /tx` | Apply a batch transaction |

## Model packs

A model pack is a normal Node package exporting an `atomic: 1` definition bundle. It can extend or replace core models and include observation guidance, identity policy, resolution thresholds, merge strategies, and presentation metadata.

```js
export default {
  atomic: 1,
  name: '@example/models-crm',
  version: '1.0.0',
  models: [{
    name: 'contact',
    extends: 'person',
    description: 'A CRM contact.',
    attributes: {
      accountId: { kind: 'text', required: true }
    },
    identity: [{
      name: 'account',
      fields: ['accountId'],
      strength: 'definitive',
      exclusive: true
    }]
  }]
};
```

The model-pack JSON Schema is at [`docs/model-pack.schema.json`](docs/model-pack.schema.json).

## Development

```bash
npm test
npm run test:parser
npm run test:fold
npm run check
npm run audit
```

The parser and fold suites cover model loading, inheritance, overrides, provider execution, normalization, identity hashing, exact-key merging, contradiction blocking, assertion preservation, review creation, and reversible merges.

## Status

Atomic is early-stage software. The in-memory fold store is a reference implementation; production deployments should implement the documented fold-store contract through the Atomic kernel or another transactional durable store.

## License

MIT

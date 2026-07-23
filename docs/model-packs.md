# Atomic model packs and parser API

Atomic is a Node.js runtime that turns observations into typed, evidence-backed atoms. The runtime supplies the parser contract, model registry, confidence workflow, provenance shape, and persistence boundary. Model packs teach the parser what exists in a domain and how those things should be recognized.

## Install and create a runtime

```bash
npm install atomic
```

```js
import { createAtomic } from 'atomic';

const atomic = await createAtomic({
  modelDirectory: './atomic/models'
});
```

Atomic loads definitions in this order:

1. the built-in core model pack;
2. packs supplied through `models`;
3. files in `atomic/models` or the configured model directory.

Later definitions replace earlier definitions with the same model name. This makes the defaults useful without making them authoritative: a project-local `person` model can replace the built-in `person` model while still extending `thing`.

## Built-in models

Atomic ships with four deliberately broad primitives:

- `person` — a human individual;
- `place` — a physical or jurisdictional location;
- `thing` — an object, concept, artifact, asset, or otherwise distinguishable entity;
- `event` — something that happened, is happening, or is scheduled to happen.

These are a common interchange vocabulary, not a complete business ontology. Domain packs should introduce more specific models and may override the defaults.

```js
import { coreModelPack } from 'atomic/core-models';
```

## The model-pack format

A model pack is an ordinary JavaScript object exported by a Node package or project file.

```js
export default {
  atomic: 1,
  name: '@acme/models-manufacturing',
  version: '1.0.0',
  description: 'Manufacturing domain definitions.',
  models: [
    {
      name: 'supplier',
      extends: 'thing',
      description: 'An organization capable of supplying a product or service.',
      attributes: {
        name: { kind: 'text', required: true },
        supplierId: { kind: 'text' },
        website: { kind: 'url' }
      },
      identity: [
        { fields: ['supplierId'], strength: 'strong' },
        { fields: ['website'], strength: 'medium' },
        { fields: ['name'], strength: 'weak' }
      ],
      observe: {
        positive: ['supplier headings', 'vendor records', 'quoted-by language'],
        negative: ['customers', 'carriers', 'manufactured parts'],
        instructions: 'Require evidence that the entity supplies something.'
      },
      presentation: {
        label: 'Supplier',
        title: 'name',
        subtitle: 'supplierId'
      }
    }
  ]
};
```

### Required pack fields

- `atomic` — model-pack format version; currently `1`.
- `name` — stable package identifier.
- `models` — an array of model definitions.

### Model fields

- `name` — lowercase kebab-case identifier.
- `description` — semantic definition used by people and providers.
- `extends` — optional parent model.
- `attributes` — typed fields expected on candidate and persisted atoms.
- `relationships` — named graph edges.
- `identity` — ordered evidence used for matching and deduplication.
- `observe` — recognition instructions, positive signals, and negative signals.
- `presentation` — default labels for generated interfaces.

Definitions are data. A pack should not execute arbitrary extraction code merely by being loaded. Input adapters and semantic providers remain separate package boundaries.

## Package distribution

A commercial or community model pack is a normal Node package:

```bash
npm install atomic @acme/models-manufacturing
```

```js
import { createAtomic } from 'atomic';
import manufacturing from '@acme/models-manufacturing';

const atomic = await createAtomic({
  models: [manufacturing]
});
```

A pack can depend on another pack at the package-manager level and extend its model names. Atomic resolves inheritance only after every requested pack is loaded.

## Project-local models and overrides

Atomic autoloads `.mjs`, `.js`, and `.json` pack files from `atomic/models` by default.

```text
atomic/
└── models/
    ├── customer.models.mjs
    ├── shipment.models.mjs
    └── project-overrides.json
```

Disable or move autoloading when creating the runtime:

```js
await createAtomic({ modelDirectory: false });
await createAtomic({ modelDirectory: './definitions' });
```

When two loaded packs define the same model, the later definition wins. Inheritance is resolved against the final registry, so an override can continue to extend a shared primitive.

## Observing and parsing

`observe()` is read-only. It asks the configured provider to inspect an input against the loaded model registry and returns candidates, relationships, evidence, confidence, and warnings.

```js
const observation = await atomic.observe({
  name: 'supplier-email.txt',
  text: 'Jane Smith at Acme Magnets quoted part RM-42.'
});
```

`parse()` performs observation, confidence classification, and persistence through the configured sink.

```js
const result = await atomic.parse({
  path: './supplier-email.txt'
});

console.log(result.accepted);
console.log(result.review);
console.log(result.rejected);
console.log(result.persisted);
```

The default thresholds are:

- `0.90` — automatically accepted and persisted;
- `0.65` — retained for review;
- below `0.65` — rejected.

```js
const atomic = await createAtomic({
  thresholds: { persist: 0.95, review: 0.75 }
});
```

Use `persist: false` for a parse result that performs classification without writing. Use `accept: 'all'` to persist every candidate at or above the review threshold. A custom acceptance function may implement project policy.

## Provider contract

Atomic owns the provider interface but does not require a specific AI vendor.

```js
const provider = {
  name: 'company-observer',

  async observe(request) {
    // request.input: normalized text or bytes
    // request.models: fully resolved model definitions
    // request.context: caller-supplied domain context
    // request.thresholds: current confidence policy

    return {
      provider: 'company-observer',
      candidates: [
        {
          model: 'person',
          attributes: { name: 'Jane Smith' },
          confidence: 0.97,
          evidence: [
            {
              source: request.input.name,
              excerpt: 'Jane Smith at Acme Magnets'
            }
          ],
          rationale: 'A named human associated with an organization.'
        }
      ],
      relationships: [],
      warnings: []
    };
  }
};

const atomic = await createAtomic({ provider });
```

A provider must emit only models present in `request.models`. Atomic rejects unknown model names rather than silently accepting an invented ontology.

The package includes a conservative deterministic provider for development. It recognizes a narrow set of obvious email and dated-event patterns. Production semantic extraction should inject an LLM-backed, rules-backed, or hybrid provider.

## Sink contract

A sink persists accepted candidates. The default in-memory sink is useful for tests and demonstrations.

```js
const sink = {
  async persist(observation) {
    return observation.candidates.map(candidate => writeToAtomicKernel(candidate));
  }
};

const atomic = await createAtomic({ sink });
```

A sink receives the complete observation, including provenance. It returns the persisted atoms. This boundary allows the parser package API to work with the existing Atomic kernel, a remote Atomic HTTP service, or a controlled review queue without coupling semantic extraction to storage.

## Streaming

```js
for await (const event of atomic.parseStream(input)) {
  console.log(event.type, event.data);
}
```

The stream emits lifecycle events such as `parse.started`, `observation.completed`, `candidate.detected`, `atom.persisted`, and `parse.completed`.

## Model-pack quality

A professional model pack should ship fixtures and assertions for:

- positive recognition;
- negative recognition;
- ambiguous cases;
- relationship extraction;
- identity resolution;
- override compatibility;
- precision and recall by model.

Model packs are valuable because they encode tested domain meaning, not because they contain large prompt strings. Version changes should follow semantic versioning and document ontology migrations.

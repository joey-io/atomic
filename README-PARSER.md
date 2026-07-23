# Atomic parser and fold API

Atomic is an evidence-backed data substrate that can be imported as a Node.js package.

The package ships two connected mechanisms:

1. **Observation** — model packs teach a provider what to identify in an input.
2. **Folding** — deterministic identity policies decide whether each candidate creates, merges, or enters review.

```js
import { createAtomic } from 'atomic';

const atomic = await createAtomic({
  models: ['@atomic/models-public-affairs'],
  provider
});

const preview = await atomic.observe(input);
const result = await atomic.parse(input);
```

Atomic loads the built-in `person`, `place`, `thing`, and `event` definitions first, then installed packs, then project-local definitions. Later definitions override earlier ones.

See:

- [`docs/model-packs.md`](./docs/model-packs.md) for the definition and package format.
- [`docs/architecture-parser.md`](./docs/architecture-parser.md) for parser boundaries.
- [`docs/folding.md`](./docs/folding.md) for identity resolution, deduplication, merge policies, provenance, and reversible merges.

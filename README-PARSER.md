# Atomic parser quickstart

```js
import { createAtomic } from 'atomic';

const atomic = await createAtomic({
  models: [],
  modelDirectory: './atomic/models'
});

const preview = await atomic.observe('Jane Smith <jane@example.com> called.');
const result = await atomic.parse('Jane Smith <jane@example.com> called.');
```

Atomic loads the built-in `person`, `place`, `thing`, and `event` definitions first, then installed packs, then project-local definitions. Later definitions override earlier ones.

See [`docs/model-packs.md`](./docs/model-packs.md) for the complete model-pack and provider contracts.

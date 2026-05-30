import { model } from './_lib.mjs';

// A plugin bundles models, indexes, and handler names to install together.
export default model('plugin', 'Plugin', {
  name: { kind: 'text', required: true },
  version: { kind: 'integer' },
  models: { kind: 'list' },
  indexes: { kind: 'list' },
  handlers: { kind: 'list' },
});

import { model } from './_lib.mjs';

// A one-way schema transform: moves a model from version `from` to `to`. The
// model atom exists and validates; applying migrations on read is still TODO.
export default model('migration', 'Migration', {
  model: { kind: 'ref', to: 'atom://model' },
  from: { kind: 'integer' },
  to: { kind: 'integer' },
  op: { kind: 'enum', values: ['rename', 'default', 'custom'] },
  spec: { kind: 'json' },
  run: { kind: 'text' },
});

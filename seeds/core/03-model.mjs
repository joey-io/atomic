import { model } from './_lib.mjs';

// The model of models: an atom whose type is `atom://model` defines a type. The
// kernel's own types are model atoms, so the kernel runs on the same machinery
// as the data it stores.
export default model('model', 'Model', {
  label: { kind: 'text' },
  fields: { kind: 'map', required: true },
  indexes: { kind: 'map' },
  rules: { kind: 'json' },
  display: { kind: 'json' },
  behavior: { kind: 'json' },
});

import { model } from './_lib.mjs';

// Kernel and tenant settings, as key/value atoms.
export default model('config', 'Config', {
  key: { kind: 'text', required: true },
  value: { kind: 'json' },
});

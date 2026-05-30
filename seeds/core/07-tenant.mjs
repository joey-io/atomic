import { model } from './_lib.mjs';

// A tenant is the isolation boundary: an atom's nearest tenant ancestor (walk
// lifecycle.parent) decides who may see and write it.
export default model('tenant', 'Tenant', {
  name: { kind: 'text', required: true },
});

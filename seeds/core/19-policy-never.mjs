import { atom } from './_lib.mjs';

// Never expires — no conditions. The substrate's own atoms reference this.
export default atom('policy-never', 'policy', 'Never expires', {
  label: 'Never',
  conditions: [],
});

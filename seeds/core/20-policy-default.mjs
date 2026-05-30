import { atom } from './_lib.mjs';

// The default policy new atoms inherit: expire 3 years after last update.
export default atom('policy-default', 'policy', 'Expires 3 years after last update', {
  label: '3 years since update',
  conditions: ['atom://cond-stale-3y'],
});

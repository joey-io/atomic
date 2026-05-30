import { atom } from './_lib.mjs';

// The default retention predicate: a date field not touched in three years.
export default atom('cond-stale-3y', 'condition', 'Not updated in 3 years', {
  label: 'Not updated in 3 years',
  field: 'updatedAt',
  op: 'older',
  value: '3y',
});

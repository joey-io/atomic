import { model } from './_lib.mjs';

// A condition is a single reusable predicate { field, op, value }. op
// `older`/`newer` compares a date field against a duration (e.g. 3y) before now.
export default model('condition', 'Condition', {
  label: { kind: 'text' },
  field: { kind: 'text', required: true },
  op: { kind: 'enum', values: ['eq', 'ne', 'in', 'older', 'newer'] },
  value: { kind: 'json' },
});

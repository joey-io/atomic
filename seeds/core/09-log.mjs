import { model } from './_lib.mjs';

// The ledger: one log atom per write. Every change is itself an atom, so history
// is queryable like any other data.
export default model('log', 'Log', {
  atom: { kind: 'ref', to: 'atom://atom' },
  op: { kind: 'text' },
  actor: { kind: 'ref', to: 'atom://token' },
  session: { kind: 'ref', to: 'atom://session' },
  at: { kind: 'datetime' },
  changes: { kind: 'list' },
});

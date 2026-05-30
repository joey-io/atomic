import { model } from './_lib.mjs';

// An index is a stored query: it ranges `over` a model (or atom://atom, every
// atom), filters by `match`, sorts, and optionally paginates. Queries are atoms.
export default model('index', 'Index', {
  label: { kind: 'text' },
  over: { kind: 'ref', to: 'atom://model' },
  params: { kind: 'map' },
  match: { kind: 'json' },
  sort: { kind: 'list' },
  returns: { kind: 'text' },
});

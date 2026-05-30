import { atom } from './_lib.mjs';

// Atoms of a chosen model (params.model), newest first.
export default atom('atom.byModel', 'index', 'Atoms of a chosen model', {
  label: 'Atoms by model',
  over: 'atom://atom',
  params: { model: { kind: 'ref', to: 'atom://model' } },
  match: { model: 'params.model' },
  sort: [{ createdAt: 'desc' }],
  returns: 'set',
});

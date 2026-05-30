import { atom } from './_lib.mjs';

// The cross-model activity feed: every atom, newest first, paginated by date.
export default atom('atom.byDate', 'index', 'Atoms across all models, newest first', {
  label: 'Atoms by date',
  over: 'atom://atom',
  sort: [{ createdAt: 'desc' }],
  page: { cursor: 'createdAt', limit: 25 },
  returns: 'page',
});

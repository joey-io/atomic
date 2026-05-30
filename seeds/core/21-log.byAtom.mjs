import { atom } from './_lib.mjs';

// Full change history for one atom (params.atom), oldest first.
export default atom('log.byAtom', 'index', 'Full change history for one atom', {
  label: 'Log by atom',
  over: 'atom://log',
  params: { atom: { kind: 'ref', to: 'atom://atom' } },
  match: { atom: 'params.atom' },
  sort: [{ at: 'asc' }],
  returns: 'set',
});

import { atom } from './_lib.mjs';

// Genesis: joey is the root authority. Holds `**` (all paths, all modes), so it
// is the only principal that can mint capabilities; every other token descends
// from it.
export default atom('joey', 'token', 'Joey — admin', {
  email: 'joey@emailjoey.com',
  grants: [{ path: '**', mode: 'all' }],
}, 'joey');

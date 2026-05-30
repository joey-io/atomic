import { model } from './_lib.mjs';

// A session binds a cookie id to the token it authenticates. It is a bearer
// credential — the surface never serves session atoms.
export default model('session', 'Session', {
  token: { kind: 'ref', to: 'atom://token' },
  createdAt: { kind: 'datetime' },
  expiresAt: { kind: 'datetime' },
});

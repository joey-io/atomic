import { atom } from './_lib.mjs';

// atom://0 — the public/anonymous identity that also describes the app. Holds no
// data grants, so an unauthenticated request resolves here and sees the app's
// description but no records. Its self-description lives in the manifest; attr
// is empty.
export default atom('0', 'token',
  'A data substrate where schema, data, identity, permissions, and every surface are all atoms — one organism, generated from the same core atoms and rendered on any surface.',
  {}, 'joey');

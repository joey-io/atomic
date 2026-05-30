import { model } from './_lib.mjs';

// A policy is a set of condition atoms; lifecycle.expiration points at one. An
// atom expires when ALL the policy's conditions hold (none → never expires).
export default model('policy', 'Policy', {
  label: { kind: 'text' },
  conditions: { kind: 'list', of: { kind: 'ref', to: 'atom://condition' } },
});

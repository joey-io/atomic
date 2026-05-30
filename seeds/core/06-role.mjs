import { model } from './_lib.mjs';

// A role is a reusable bundle of grants a token references via attr.roles; its
// effective grants are its own plus its roles'.
export default model('role', 'Role', {
  label: { kind: 'text' },
  grants: { kind: 'list', of: 'embed://grant' },
});

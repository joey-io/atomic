import { model } from './_lib.mjs';

// A token is an identity. Its grants are its capabilities; roles are reusable
// grant bundles it inherits. A token with an email signs in by magic link.
export default model('token', 'Token', {
  email: { kind: 'email' },
  login: { kind: 'enum', values: ['open'] },
  grants: { kind: 'list', of: 'embed://grant' },
  roles: { kind: 'list' },
});

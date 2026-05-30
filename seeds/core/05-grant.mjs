import { model } from './_lib.mjs';

// A grant gives a token access to a ref (a model, an index, or an attribute
// path) for one mode. `write` = create+update+delete (NOT read); `all` =
// everything; `read` is its own mode.
export default model('grant', 'Grant', {
  path: { kind: 'text', required: true },
  mode: { kind: 'enum', values: ['read', 'create', 'update', 'delete', 'write', 'all'] },
});

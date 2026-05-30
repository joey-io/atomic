import { model } from './_lib.mjs';

// A hook is a capability atom { run, grants } registered in an atom's
// lifecycle.hooks. `run` names a vetted script in scripts/ — constrained to a
// bare basename (no slashes/dots) so it can never traverse out of that directory.
export default model('hook', 'Hook', {
  label: { kind: 'text' },
  run: { kind: 'text', required: true, pattern: '^[a-z0-9][a-z0-9-]*$' },
  grants: { kind: 'list', of: 'embed://grant' },
});

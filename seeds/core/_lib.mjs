// Builders for the core seed atoms. Self-contained — no kernel imports — so the
// substrate's own schema is plain data the kernel loads at boot, not code baked
// into the engine. Each NN-<id>.mjs file default-exports one atom built here;
// the kernel reads this directory in filename order and seeds what it finds.

const now = () => new Date().toISOString();
const ref = (id) => `atom://${id}`;

// Every core atom references the 'never' policy — the substrate's own schema must
// not expire out from under itself. Genesis provenance: created by `by`, parented
// under `parent` (atom://0, the root) unless told otherwise.
export const lc = (by = '0', parent = '0') => ({
  status: 'active',
  version: 1,
  modelVersion: 1,
  createdAt: now(),
  updatedAt: now(),
  createdBy: ref(by),
  parent: ref(parent),
  expiration: 'atom://policy-never',
});

// a model atom: an atom whose type is `atom://model`. Its attr is the schema.
export const model = (id, label, fields, extra = {}) => ({
  id,
  model: 'atom://model',
  manifest: label,
  attr: { label, version: 1, fields, ...extra },
  lifecycle: lc('0'),
});

// any other core atom: a token, condition, policy, or index.
export const atom = (id, kind, manifest, attr, by = '0') => ({
  id,
  model: `atom://${kind}`,
  manifest,
  attr,
  lifecycle: lc(by),
});

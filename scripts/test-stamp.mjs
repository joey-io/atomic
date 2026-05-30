// Test-only hook fixture (no network): stamps an atom so the suite can prove
// hook delegation — the hook writes a field the caller isn't allowed to write.
export default async function stamp(atom, { patch }) {
  if (atom.attr.name && atom.attr.stamp !== 'ok') patch({ stamp: 'ok' });
}

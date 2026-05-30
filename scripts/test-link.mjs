// Test-only hook fixture (no network): mirrors the census/district pattern —
// upsert a related atom and link the subject to it, under the hook's grants.
export default async function link(atom, { patch, upsert }) {
  if (!atom.attr.name || atom.attr.tag) return;
  const tag = upsert('tag', `tag-${atom.attr.name.toLowerCase()}`, { label: atom.attr.name });
  patch({ tag });
}

// Test-only migration fixture (no network): a `custom` migration handler. It
// receives the atom's attr bag and returns the next one — here it derives a
// `slug` from the title, the kind of computed field a rename/default can't do.
export default function migrate(attr) {
  if (attr.title && attr.slug === undefined)
    return { ...attr, slug: String(attr.title).toLowerCase().replace(/\s+/g, '-') };
  return attr;
}

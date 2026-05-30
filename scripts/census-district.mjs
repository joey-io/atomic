// Hook handler for the advocate model. Geocodes the advocate's embedded address
// against the US Census, upserts the matching congressional-district atom, and
// links advocate.cd to it. Registered by a `hook` atom whose grants are
// advocate.cd (write) + census.* (write). Runs under the hook's authority.
export default async function censusDistrict(atom, { patch, upsert, getAtom, refId }) {
  const a = atom.attr.address;
  if (!a || !a.street) return;

  // address.state is a ref to a state atom — resolve it to a two-letter abbr
  let abbr = '';
  if (a.state && a.state.startsWith && a.state.startsWith('atom://')) {
    try { abbr = getAtom(refId(a.state)).attr.abbr || ''; } catch { /* unknown */ }
  } else if (typeof a.state === 'string') abbr = a.state;

  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/address');
  u.searchParams.set('street', a.street);
  u.searchParams.set('city', a.city || '');
  u.searchParams.set('state', abbr);
  if (a.zip) u.searchParams.set('zip', a.zip);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('vintage', 'Current_Current');
  u.searchParams.set('format', 'json');

  const data = await (await fetch(u)).json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return;
  const layer = Object.keys(match.geographies || {}).find((k) => /congress/i.test(k));
  const num = layer && match.geographies[layer][0]?.BASENAME;
  if (!num) return;

  const n = parseInt(num, 10);
  const padded = String(n).padStart(2, '0');
  const id = `cd-${abbr.toLowerCase()}-${padded}`;
  const cd = upsert('census', id, { state: a.state, district: n, name: `${abbr}-${padded}` });
  if (atom.attr.cd !== cd) patch({ cd });
}

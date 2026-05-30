// Hook handler for the advocate model. When an advocate has an address, geocode
// it against the US Census and write its congressional district number.
// Registered by a `hook` atom { on: atom://advocate, run: 'census-district' }.
//
// Receives the written atom and helpers { patch, getAtom, refId, ref }.
// patch(fields) updates the atom without re-triggering hooks.
export default async function censusDistrict(atom, { patch, getAtom, refId }) {
  const a = atom.attr.address;
  if (!a || !a.street) return;                          // nothing to geocode

  // address.state is a ref to a state atom — resolve it to a two-letter abbr
  let state = '';
  if (a.state && a.state.startsWith && a.state.startsWith('atom://')) {
    try { state = getAtom(refId(a.state)).attr.abbr || ''; } catch { /* unknown state */ }
  } else if (typeof a.state === 'string') state = a.state;

  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/address');
  u.searchParams.set('street', a.street);
  u.searchParams.set('city', a.city || '');
  u.searchParams.set('state', state);
  if (a.zip) u.searchParams.set('zip', a.zip);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('vintage', 'Current_Current');
  u.searchParams.set('format', 'json');

  const res = await fetch(u);
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return;                                   // no geocode match

  const layer = Object.keys(match.geographies || {}).find((k) => /congress/i.test(k));
  const district = layer && match.geographies[layer][0]?.BASENAME;
  if (district && String(district) !== String(atom.attr.congress)) {
    patch({ congress: String(district) });              // write it back (idempotent)
  }
}

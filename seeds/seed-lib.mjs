// Helpers for the demo seeds. Everything is POSTed through the API as the admin
// token, so seeding is just atom CRUD — nothing special, nothing in the kernel.
//   ATOMIC_BASE  (default http://localhost:3040)
//   ATOMIC_TOKEN (default joey — the admin/superuser)
const BASE = process.env.ATOMIC_BASE || 'http://localhost:3040';
const TOKEN = process.env.ATOMIC_TOKEN || 'joey';
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const okOrExists = (r, what) => {
  if (r.status !== 201 && r.status !== 409) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
};

// `hooks` (optional) registers lifecycle hooks on the model atom itself —
// e.g. { create: ['atom://census-district'], update: [...] } — so every instance
// of the model triggers them. It lands in lifecycle.hooks, not attr.
export async function model(id, label, fields, extra = {}, hooks) {
  okOrExists(await api('POST', '/model', { id, manifest: label, attr: { label, version: 1, fields, ...extra }, ...(hooks ? { hooks } : {}) }), `model ${id}`);
}
export async function tenant(id, name) {
  okOrExists(await api('POST', '/tenant', { id, manifest: name, attr: { name } }), `tenant ${id}`);
}
export async function token(id, parent, attr) {
  okOrExists(await api('POST', '/token', { id, parent: 'atom://' + parent, attr }), `token ${id}`);
}
// a hook is a capability atom { run, grants }; registered by id in some atom's
// lifecycle.hooks. Global by default (parent atom://0) so global models can use it.
export async function hook(id, run, grants, parent = '0') {
  okOrExists(await api('POST', '/hook', { id, parent: 'atom://' + parent, manifest: run, attr: { label: run, run, grants } }), `hook ${id}`);
}
// a role is a reusable bundle of grants that tokens reference via attr.roles
export async function role(id, label, grants, parent = '0') {
  okOrExists(await api('POST', '/role', { id, parent: 'atom://' + parent, manifest: label, attr: { label, grants } }), `role ${id}`);
}
// the 50 states + DC, seeded as global reference atoms (parent atom://0)
const STATES = [
  ['AL', 'Alabama'],              ['AK', 'Alaska'],               ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],             ['CA', 'California'],           ['CO', 'Colorado'],
  ['CT', 'Connecticut'],          ['DE', 'Delaware'],             ['DC', 'District of Columbia'],
  ['FL', 'Florida'],              ['GA', 'Georgia'],              ['HI', 'Hawaii'],
  ['ID', 'Idaho'],                ['IL', 'Illinois'],             ['IN', 'Indiana'],
  ['IA', 'Iowa'],                 ['KS', 'Kansas'],               ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],            ['ME', 'Maine'],                ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],        ['MI', 'Michigan'],             ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],          ['MO', 'Missouri'],             ['MT', 'Montana'],
  ['NE', 'Nebraska'],             ['NV', 'Nevada'],               ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],           ['NM', 'New Mexico'],           ['NY', 'New York'],
  ['NC', 'North Carolina'],       ['ND', 'North Dakota'],         ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],             ['OR', 'Oregon'],               ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],         ['SC', 'South Carolina'],       ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],            ['TX', 'Texas'],                ['UT', 'Utah'],
  ['VT', 'Vermont'],              ['VA', 'Virginia'],             ['WA', 'Washington'],
  ['WV', 'West Virginia'],        ['WI', 'Wisconsin'],            ['WY', 'Wyoming'],
];
export async function defineStates() {
  for (const [abbr, name] of STATES) await atom('state', `st-${abbr.toLowerCase()}`, '0', { name, abbr }, name);
}
export async function index(id, label, over, params, match, sort) {
  okOrExists(await api('POST', '/index', { id, manifest: label, attr: { label, over, params, match, sort, returns: 'set' } }), `index ${id}`);
}
// create an atom of `m` under tenant `parent`
export async function atom(m, id, parent, attr, manifest) {
  okOrExists(await api('POST', '/' + m, { id, parent: 'atom://' + parent, manifest: manifest || id, attr }), `${m} ${id}`);
}
export const A = (id) => 'atom://' + id;

// real US city-hall addresses [street, city, state-abbr, zip] — used so the
// census-district hook has something genuine to geocode into a congressional district.
export const ADDR = [
  ['100 Holliday St', 'Baltimore', 'MD', '21202'],
  ['200 W Washington St', 'Phoenix', 'AZ', '85003'],
  ['1437 Bannock St', 'Denver', 'CO', '80202'],
  ['600 4th Ave', 'Seattle', 'WA', '98104'],
  ['1221 SW 4th Ave', 'Portland', 'OR', '97204'],
  ['1 Dr Carlton B Goodlett Pl', 'San Francisco', 'CA', '94102'],
  ['121 N LaSalle St', 'Chicago', 'IL', '60602'],
  ['1 City Hall Sq', 'Boston', 'MA', '02201'],
  ['1500 Marilla St', 'Dallas', 'TX', '75201'],
  ['55 Trinity Ave SW', 'Atlanta', 'GA', '30303'],
  ['350 S 5th St', 'Minneapolis', 'MN', '55415'],
  ['1 Public Sq', 'Nashville', 'TN', '37201'],
];
// build an advocate address embed (state is a ref to a global state atom)
export const addr = (i) => { const [street, city, st, zip] = ADDR[i % ADDR.length]; return { street, city, state: A(`st-${st.toLowerCase()}`), zip }; };

// the domain models, defined once and reused by every tenant (idempotent: 409 = already there)
export async function defineModels() {
  await model('region', 'Region', { name: { kind: 'text', required: true } });
  await model('person', 'Person', {
    name: { kind: 'text', required: true },
    region: { kind: 'ref', to: 'atom://region', inverse: 'people' },
    manager: { kind: 'ref', to: 'atom://person', inverse: 'reports' },
  }, { display: { row: ['name', 'region', 'manager'] } });
  await model('fundraising', 'Fundraising', {
    amount: { kind: 'number', filterable: true, sortable: true },
    donor: { kind: 'text' },
    person: { kind: 'ref', to: 'atom://person', inverse: 'raised' },
    at: { kind: 'datetime' },
  }, { display: { row: ['amount', 'donor', 'person', 'at'] } });
  await model('official', 'Elected Official', { name: { kind: 'text', required: true }, office: { kind: 'text' } });
  await model('district', 'District', {
    name: { kind: 'text', required: true },
    official: { kind: 'ref', to: 'atom://official', inverse: 'districts' },
  });
  await model('state', 'State', { name: { kind: 'text', required: true }, abbr: { kind: 'text', required: true } });
  await model('address', 'Address', { street: { kind: 'text' }, city: { kind: 'text' },
    state: { kind: 'ref', to: 'atom://state' }, zip: { kind: 'text' } });
  await model('census', 'Congressional District', {
    state: { kind: 'ref', to: 'atom://state' }, district: { kind: 'integer' }, name: { kind: 'text' },
  });
  // the census-district hook (a capability: advocate.cd write + census.* write) is
  // created here, beside the advocate model that registers it, so the model's
  // lifecycle.hooks ref always resolves — whichever demo defines the model first.
  await hook('census-district', 'census-district',
    [{ path: 'advocate.cd', mode: 'write' }, { path: 'census.*', mode: 'write' }]);
  // the advocate model registers the census-district hook in its lifecycle, so
  // creating/updating any advocate (in any tenant) geocodes its address and links
  // advocate.cd to the matching congressional-district atom — under the hook's grants.
  await model('advocate', 'Advocate', {
    name: { kind: 'text', required: true },
    email: { kind: 'email' },
    address: 'embed://address',                          // home address — geocoded by the census hook (string shorthand)
    mailing: { kind: 'embed', of: 'atom://address' },    // optional second address — the SAME shape, reused by reference (object form)
    cd: { kind: 'ref', to: 'atom://census', inverse: 'residents' }, // congressional district, linked by the census hook
    district: { kind: 'ref', to: 'atom://district', inverse: 'advocates' },
  }, {}, { create: ['atom://census-district'], update: ['atom://census-district'] });
  await model('story', 'Story', {
    title: { kind: 'text', required: true }, body: { kind: 'longtext' },
    advocate: { kind: 'ref', to: 'atom://advocate', inverse: 'stories' },
  }, { display: { row: ['title', 'advocate'] } });
}

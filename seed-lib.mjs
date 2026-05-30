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

export async function model(id, label, fields, extra = {}) {
  okOrExists(await api('POST', '/model', { id, manifest: label, attr: { label, version: 1, fields, ...extra } }), `model ${id}`);
}
export async function tenant(id, name) {
  okOrExists(await api('POST', '/tenant', { id, manifest: name, attr: { name } }), `tenant ${id}`);
}
// create an atom of `m` under tenant `parent`
export async function atom(m, id, parent, attr, manifest) {
  okOrExists(await api('POST', '/' + m, { id, parent: 'atom://' + parent, manifest: manifest || id, attr }), `${m} ${id}`);
}
export const A = (id) => 'atom://' + id;

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
  await model('advocate', 'Advocate', {
    name: { kind: 'text', required: true },
    district: { kind: 'ref', to: 'atom://district', inverse: 'advocates' },
  });
  await model('story', 'Story', {
    title: { kind: 'text', required: true }, body: { kind: 'longtext' },
    advocate: { kind: 'ref', to: 'atom://advocate', inverse: 'stories' },
    district: { kind: 'ref', to: 'atom://district' },
  }, { display: { row: ['title', 'advocate', 'district'] } });
}

// Demo D — a household: a 3-bedroom house, every room, all the stuff inside it,
// and the people who live there. Models the real sharing rules — two adults share
// the master bedroom, the two kids share the hall bathroom, and everyone uses the
// family room — as first-class, queryable edges. Run: node seed-d.mjs
//
// Earle is one of the two adults; he also gets an open-login token (atom://earle,
// earled@me.com) so he can one-click into the house from the homepage and read it.
import { tenant, model, token, atom, index, A } from './seed-lib.mjs';

// raw PATCH (update) as the admin token — used by lockToHouse() to install the
// graph-gated write rules and Earle's house anchor after the data exists.
const BASE = process.env.ATOMIC_BASE || 'http://localhost:3040';
const TOK = process.env.ATOMIC_TOKEN || 'joey';
async function patch(id, attr) {
  const r = await fetch(`${BASE}/${id}`, { method: 'PATCH',
    headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' },
    body: JSON.stringify({ attr }) });
  if (r.status !== 200) throw new Error(`patch ${id}: ${r.status} ${await r.text()}`);
}

// ---------------------------------------------------------------------------
// Models — the household domain. Global + idempotent (409 = already defined),
// so re-running is safe and other tenants could reuse them.
// ---------------------------------------------------------------------------
await model('house', 'House', {
  name: { kind: 'text', required: true },
  address: { kind: 'text' },
  bedrooms: { kind: 'integer' },
  // self-anchor: a house's `home` is itself — the root of its own ref tree. The
  // write rule `home == actor.house` lets the house's owner edit the house atom
  // (readField can't read `.id`, so the tree root needs a ref field to compare).
  home: { kind: 'ref', to: 'atom://house' },
}, { display: { row: ['name', 'address', 'bedrooms'] } });

await model('room', 'Room', {
  name: { kind: 'text', required: true },
  kind: { kind: 'enum', values: ['bedroom', 'bathroom', 'family', 'kitchen', 'living', 'dining', 'garage', 'office'] },
  shared: { kind: 'boolean' },
  house: { kind: 'ref', to: 'atom://house', inverse: 'rooms' },
}, { display: { row: ['name', 'kind', 'shared', 'house'] } });

await model('resident', 'Resident', {
  name: { kind: 'text', required: true },
  role: { kind: 'enum', values: ['adult', 'child'] },
  age: { kind: 'integer' },
  house: { kind: 'ref', to: 'atom://house', inverse: 'residents' },
  // where this person sleeps. Two residents pointing at the same bedroom = they
  // share it (the two adults share the master; each kid has their own).
  bedroom: { kind: 'ref', to: 'atom://room', inverse: 'occupants' },
}, { display: { row: ['name', 'role', 'age', 'bedroom'] } });

// the "stuff inside it" — every object lives in a room and (if personal) has an owner.
await model('belonging', 'Belonging', {
  name: { kind: 'text', required: true },
  category: { kind: 'enum', values: ['furniture', 'appliance', 'electronics', 'decor', 'kitchenware', 'toy', 'book', 'linen', 'tool'] },
  room: { kind: 'ref', to: 'atom://room', inverse: 'contents' },
  owner: { kind: 'ref', to: 'atom://resident', inverse: 'belongings' },
}, { display: { row: ['name', 'category', 'room', 'owner'] } });

// a usage edge: a person uses a room for a purpose. This is the atom that makes
// "they all use the family room" and "the two kids share a bathroom" queryable —
// each fact is one edge, countable by usage.byRoom.
await model('usage', 'Usage', {
  resident: { kind: 'ref', to: 'atom://resident', inverse: 'uses' },
  room: { kind: 'ref', to: 'atom://room', inverse: 'users' },
  purpose: { kind: 'text' },
}, { display: { row: ['resident', 'room', 'purpose'] } });

// ---------------------------------------------------------------------------
// Indexes — stored queries over the household.
// ---------------------------------------------------------------------------
await index('room.byHouse', 'Rooms in a house', 'atom://room',
  { house: { kind: 'ref', to: 'atom://house' } }, { house: 'params.house' }, [{ name: 'asc' }]);
await index('room.byKind', 'Rooms by kind', 'atom://room',
  { kind: { kind: 'enum', values: ['bedroom', 'bathroom', 'family', 'kitchen', 'living', 'dining', 'garage', 'office'] } },
  { kind: 'params.kind' }, [{ name: 'asc' }]);
await index('resident.byBedroom', 'Who sleeps in a bedroom', 'atom://resident',
  { bedroom: { kind: 'ref', to: 'atom://room' } }, { bedroom: 'params.bedroom' }, [{ name: 'asc' }]);
await index('belonging.byRoom', 'Stuff in a room', 'atom://belonging',
  { room: { kind: 'ref', to: 'atom://room' } }, { room: 'params.room' }, [{ name: 'asc' }]);
await index('belonging.byOwner', "A person's belongings", 'atom://belonging',
  { owner: { kind: 'ref', to: 'atom://resident' } }, { owner: 'params.owner' }, [{ name: 'asc' }]);
await index('usage.byRoom', 'Who uses a room', 'atom://usage',
  { room: { kind: 'ref', to: 'atom://room' } }, { room: 'params.room' }, [{ purpose: 'asc' }]);
await index('usage.byResident', 'What rooms a person uses', 'atom://usage',
  { resident: { kind: 'ref', to: 'atom://resident' } }, { resident: 'params.resident' }, [{ purpose: 'asc' }]);

// ---------------------------------------------------------------------------
// Schema extensions + UNLOCK. ensureSchema adds the `home` self-anchor to the
// house model and an optional `house` ref to the core token model. unlock clears
// the household write-rules so joey can (re)build the data — re-running this seed
// after the house is locked would otherwise 403 (joey owns no house). lockToHouse
// re-applies the real rules at the very end.
// ---------------------------------------------------------------------------
const HOUSEHOLD = ['house', 'room', 'resident', 'belonging', 'usage'];
async function ensureSchema() {
  await patch('house', { fields: {
    name: { kind: 'text', required: true }, address: { kind: 'text' },
    bedrooms: { kind: 'integer' }, home: { kind: 'ref', to: 'atom://house' } } });
  await patch('token', { fields: {
    email: { kind: 'email' }, login: { kind: 'enum', values: ['open'] },
    grants: { kind: 'list', of: 'embed://grant' }, roles: { kind: 'list' },
    house: { kind: 'ref', to: 'atom://house' } } });
}
async function setRules(write) { for (const m of HOUSEHOLD) await patch(m, { rules: { write } }); }
await ensureSchema();
await setRules('true');   // unlock for the build

// ---------------------------------------------------------------------------
// The data — tenant D, the Henderson house.
// ---------------------------------------------------------------------------
await tenant('d', 'Demo D — Household');
const T = 'd';

await atom('house', 'd-house', T, { name: 'The Henderson House', address: '14 Maple Court', bedrooms: 3, home: A('d-house') }, 'The Henderson House');

// rooms: 3 bedrooms + family room + kitchen + 2 bathrooms.
// NOTE: every atom id is globally unique in the store, so rooms are namespaced
// `d-rm-*` and residents `d-res-*` — a room and a person must never share an id.
await atom('room', 'd-rm-master',  T, { name: 'Master Bedroom', kind: 'bedroom', shared: true,  house: A('d-house') }, 'Master Bedroom');
await atom('room', 'd-rm-maya',    T, { name: "Maya's Room",    kind: 'bedroom', shared: false, house: A('d-house') }, "Maya's Room");
await atom('room', 'd-rm-theo',    T, { name: "Theo's Room",    kind: 'bedroom', shared: false, house: A('d-house') }, "Theo's Room");
await atom('room', 'd-rm-family',  T, { name: 'Family Room',    kind: 'family',  shared: true,  house: A('d-house') }, 'Family Room');
await atom('room', 'd-rm-kitchen', T, { name: 'Kitchen',        kind: 'kitchen', shared: true,  house: A('d-house') }, 'Kitchen');
await atom('room', 'd-rm-bath-m',  T, { name: 'Master Bath',    kind: 'bathroom', shared: true, house: A('d-house') }, 'Master Bath');
await atom('room', 'd-rm-bath-h',  T, { name: 'Hall Bath',      kind: 'bathroom', shared: true, house: A('d-house') }, 'Hall Bath');

// residents: 2 adults (Earle + Robin share the master) + 2 kids (own bedrooms)
await atom('resident', 'd-res-earle', T, { name: 'Earle Henderson', role: 'adult', age: 41, house: A('d-house'), bedroom: A('d-rm-master') }, 'Earle Henderson');
await atom('resident', 'd-res-robin', T, { name: 'Robin Henderson', role: 'adult', age: 39, house: A('d-house'), bedroom: A('d-rm-master') }, 'Robin Henderson');
await atom('resident', 'd-res-maya',  T, { name: 'Maya Henderson',  role: 'child', age: 11, house: A('d-house'), bedroom: A('d-rm-maya') },  'Maya Henderson');
await atom('resident', 'd-res-theo',  T, { name: 'Theo Henderson',  role: 'child', age: 8,  house: A('d-house'), bedroom: A('d-rm-theo') },  'Theo Henderson');

// usage edges — the sharing rules, made queryable:
//   • everyone uses the family room   → usage.byRoom(d-rm-family)  == 4
//   • everyone uses the kitchen       → usage.byRoom(d-rm-kitchen) == 4
//   • the two adults use the master bath
//   • the two kids SHARE the hall bath → usage.byRoom(d-rm-bath-h) == 2 (both kids)
const EVERYONE = ['d-res-earle', 'd-res-robin', 'd-res-maya', 'd-res-theo'];
let u = 0;
const use = (res, room, purpose) => atom('usage', `d-use-${++u}`, T, { resident: A(res), room: A(room), purpose }, `${res} → ${room}`);
for (const r of EVERYONE) await use(r, 'd-rm-family', 'gather');
for (const r of EVERYONE) await use(r, 'd-rm-kitchen', 'meals');
await use('d-res-earle', 'd-rm-bath-m', 'wash');
await use('d-res-robin', 'd-rm-bath-m', 'wash');
await use('d-res-maya',  'd-rm-bath-h', 'wash');   // the two kids
await use('d-res-theo',  'd-rm-bath-h', 'wash');   // share the hall bathroom

// the stuff inside it — belongings per room (shared items have no owner)
const things = [
  // family room (shared)
  ['Sectional Sofa', 'furniture', 'd-rm-family', null],
  ['65" TV', 'electronics', 'd-rm-family', null],
  ['Coffee Table', 'furniture', 'd-rm-family', null],
  ['Bookshelf', 'furniture', 'd-rm-family', null],
  ['Board Games', 'toy', 'd-rm-family', null],
  // kitchen (shared)
  ['Refrigerator', 'appliance', 'd-rm-kitchen', null],
  ['Range & Oven', 'appliance', 'd-rm-kitchen', null],
  ['Dishwasher', 'appliance', 'd-rm-kitchen', null],
  ['Dining Table', 'furniture', 'd-rm-kitchen', null],
  ['Cookware Set', 'kitchenware', 'd-rm-kitchen', null],
  // master bedroom (Earle + Robin)
  ['Queen Bed', 'furniture', 'd-rm-master', null],
  ["Earle's Dresser", 'furniture', 'd-rm-master', 'd-res-earle'],
  ["Robin's Dresser", 'furniture', 'd-rm-master', 'd-res-robin'],
  ['Reading Lamp', 'decor', 'd-rm-master', 'd-res-robin'],
  ["Earle's Laptop", 'electronics', 'd-rm-master', 'd-res-earle'],
  // Maya's room
  ['Twin Bed', 'furniture', 'd-rm-maya', 'd-res-maya'],
  ['Study Desk', 'furniture', 'd-rm-maya', 'd-res-maya'],
  ['Bookcase of Novels', 'book', 'd-rm-maya', 'd-res-maya'],
  ['Tablet', 'electronics', 'd-rm-maya', 'd-res-maya'],
  // Theo's room
  ['Bunk Bed', 'furniture', 'd-rm-theo', 'd-res-theo'],
  ['Toy Chest', 'toy', 'd-rm-theo', 'd-res-theo'],
  ['Lego Bins', 'toy', 'd-rm-theo', 'd-res-theo'],
  ['Nightlight', 'decor', 'd-rm-theo', 'd-res-theo'],
  // bathrooms
  ['Master Towels', 'linen', 'd-rm-bath-m', null],
  ['Hall Towels', 'linen', 'd-rm-bath-h', null],
  ['Kids Step Stool', 'tool', 'd-rm-bath-h', null],
];
let b = 0;
for (const [name, category, room, owner] of things)
  await atom('belonging', `d-item-${++b}`, T,
    { name, category, room: A(room), ...(owner ? { owner: A(owner) } : {}) }, name);

// ---------------------------------------------------------------------------
// Earle's access — Earle OWNS the house. His open-login token (one-click on the
// homepage) gets FULL write, but only inside his own house's ref tree:
//   • read  everything in his tenant (**),
//   • update his house atom (house.**),
//   • full create/update/delete on rooms, residents, belongings, usage —
//     but every one of those writes is gated by a model write-rule (below) to
//     atoms whose ref path resolves back to his house (atom://d-house).
// The grant says WHICH OPS; the rule says WHICH ATOMS (the house ref tree).
// ---------------------------------------------------------------------------
await token('earle', 'd', { email: 'earled@me.com', login: 'open', grants: [
  { path: '**',           mode: 'read'   },
  { path: 'house.**',     mode: 'update' },
  { path: 'room.**',      mode: 'all'    },
  { path: 'resident.**',  mode: 'all'    },
  { path: 'belonging.**', mode: 'all'    },
  { path: 'usage.**',     mode: 'all'    },
] });

// lockToHouse(): anchor Earle to his house, then install the graph-gated write
// rules — run LAST, after all data exists. Once the rules are on, only a token
// whose `actor.house` matches may write the tree (joey, with no house, is
// intentionally locked out of household writes; re-running the seed unlocks via
// setRules('true') above, rebuilds, and re-locks here).
async function lockToHouse() {
  // anchor the root's `home` to itself, and Earle to the house. Re-assert Earle's
  // tree-scoped grants too — idempotent even if the token pre-existed broader.
  await patch('d-house', { home: A('d-house') });
  await patch('earle', { house: A('d-house'), grants: [
    { path: '**',           mode: 'read'   },
    { path: 'house.**',     mode: 'update' },
    { path: 'room.**',      mode: 'all'    },
    { path: 'resident.**',  mode: 'all'    },
    { path: 'belonging.**', mode: 'all'    },
    { path: 'usage.**',     mode: 'all'    },
  ] });
  // a write is allowed iff the atom's ref path resolves to the writer's house.
  // Rooms/residents link house directly; belongings and usage reach it through
  // their room; the house anchors on itself via `home`.
  await patch('house',     { rules: { write: 'home == actor.house' } });
  await patch('room',      { rules: { write: 'house == actor.house' } });
  await patch('resident',  { rules: { write: 'house == actor.house' } });
  await patch('belonging', { rules: { write: 'room.house == actor.house' } });
  await patch('usage',     { rules: { write: 'room.house == actor.house' } });
}
await lockToHouse();

console.log(`seed-d: Household — 1 house, 7 rooms, 4 residents, ${b} belongings, ${u} usage edges; open-login atom://earle (earled@me.com) — full write gated to his house ref tree`);

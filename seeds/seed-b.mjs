// Demo B — an advocacy program: stories shared by advocates from districts that
// each reference an elected official. Run: node seeds/seed-b.mjs
import { tenant, defineModels, defineStates, atom, token, hook, role, addr, A } from './seed-lib.mjs';

await defineModels();
await defineStates();
await tenant('b', 'Demo B — Advocacy');

// census-district hook: a capability whose grants are advocate.cd (write) + census.*
// (write). It is registered in the advocate model's lifecycle (see defineModels),
// so it runs on every advocate write, geocodes the embedded address, and links
// advocate.cd — under its OWN grants, not the caller's (scripts/census-district.mjs).
await hook('census-district', 'census-district',
  [{ path: 'advocate.cd', mode: 'write' }, { path: 'census.*', mode: 'write' }]);

// the "website" role: a reusable bundle of grants for public advocate intake —
// write-only on the advocate fields a public form may submit, plus read on the
// reference data such a form needs: states and congressional districts.
await role('role-website', 'Website intake', [
  { path: 'advocate.name', mode: 'write' },
  { path: 'advocate.email', mode: 'write' },
  { path: 'advocate.address', mode: 'write' },
  { path: 'advocate.district', mode: 'write' },
  { path: 'census.**', mode: 'read' },   // congressional districts (all fields)
  { path: 'state.**', mode: 'read' },    // US states (all fields)
]);

// CapConnect: open (one-click) login that wears the website role. Pure write-only
// intake — it may submit advocate fields (not cd). The census hook links cd on its
// behalf (it's the model's hook, not the caller's), and CapConnect cannot read or
// list advocates at all.
await token('capconnect', 'b', { email: 'capconnect@emailjoey.com', login: 'open', roles: ['atom://role-website'] });

const T = 'b';
const offices = ['Mayor', 'State Senator', 'US Representative', 'City Council', 'Governor'];
for (let i = 0; i < 5; i++) await atom('official', `b-off${i + 1}`, T, { name: `Hon. Official ${i + 1}`, office: offices[i] }, `Hon. Official ${i + 1}`);
for (let i = 0; i < 5; i++) await atom('district', `b-d${i + 1}`, T, { name: `District ${i + 1}`, official: A(`b-off${i + 1}`) }, `District ${i + 1}`);
// each advocate carries a real address; the model's census hook geocodes it on
// create and links advocate.cd to the matching congressional-district atom.
for (let i = 0; i < 12; i++) await atom('advocate', `b-adv${i + 1}`, T,
  { name: `Advocate ${i + 1}`, email: `advocate${i + 1}@example.org`, address: addr(i), district: A(`b-d${(i % 5) + 1}`) },
  `Advocate ${i + 1}`);
for (let i = 0; i < 30; i++) {
  const adv = (i % 12) + 1;
  await atom('story', `b-st${i + 1}`, T,
    { title: `Why this matters #${i + 1}`, body: `An advocate shared a first-hand story about the impact in their district (#${i + 1}).`, advocate: A(`b-adv${adv}`) },
    `Why this matters #${i + 1}`);
}

console.log('seed-b: Advocacy — 5 officials, 5 districts, 12 advocates, 30 stories');

// Demo C — a hybrid: both a (small) fundraising operation and an advocacy
// program in one tenant, reusing the same models. Run: node seed-c.mjs
import { tenant, defineModels, defineStates, atom, addr, A } from './seed-lib.mjs';

await defineModels();
await defineStates(); // global state atoms (idempotent) so advocate addresses resolve
await tenant('c', 'Demo C — Hybrid');

const T = 'c';

// fundraising side: 2 regions, 6 people, 25 transactions
const regionNames = ['East', 'Central'];
for (let i = 0; i < 2; i++) await atom('region', `c-region-${i + 1}`, T, { name: regionNames[i] }, regionNames[i]);
await atom('person', 'c-p1', T, { name: 'Casey Chair', region: A('c-region-1') }, 'Casey Chair');
const people = ['c-p1'];
for (let i = 1; i <= 5; i++) {
  const r = (i % 2) + 1;
  await atom('person', `c-s${i}`, T, { name: `Organizer ${i}`, region: A(`c-region-${r}`), manager: A('c-p1') }, `Organizer ${i}`);
  people.push(`c-s${i}`);
}
for (let i = 0; i < 25; i++) {
  const amount = 100 + (i * 53) % 2900;
  await atom('fundraising', `c-tx${i + 1}`, T,
    { amount, donor: `Supporter ${i + 1}`, person: A(people[i % people.length]), at: `2026-${String((i % 12) + 1).padStart(2, '0')}-20T12:00:00Z` },
    `$${amount} from Supporter ${i + 1}`);
}

// advocacy side: 3 officials, 3 districts, 6 advocates, 12 stories
for (let i = 0; i < 3; i++) await atom('official', `c-off${i + 1}`, T, { name: `Hon. Rep ${i + 1}`, office: ['Mayor', 'Senator', 'Council'][i] }, `Hon. Rep ${i + 1}`);
for (let i = 0; i < 3; i++) await atom('district', `c-d${i + 1}`, T, { name: `Ward ${i + 1}`, official: A(`c-off${i + 1}`) }, `Ward ${i + 1}`);
for (let i = 0; i < 6; i++) await atom('advocate', `c-adv${i + 1}`, T,
  { name: `Member ${i + 1}`, email: `member${i + 1}@example.org`, address: addr(i + 6), district: A(`c-d${(i % 3) + 1}`) },
  `Member ${i + 1}`);
for (let i = 0; i < 12; i++) {
  const adv = (i % 6) + 1;
  await atom('story', `c-st${i + 1}`, T,
    { title: `Member voice #${i + 1}`, body: `A member who also donates shared how the program changed things (#${i + 1}).`, advocate: A(`c-adv${adv}`) },
    `Member voice #${i + 1}`);
}

console.log('seed-c: Hybrid — fundraising (2 regions/6 people/25 tx) + advocacy (3 officials/3 districts/6 advocates/12 stories)');

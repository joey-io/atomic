// Demo A — a PAC: 100 fundraising transactions to 20 people, a reporting chain
// via `manager` refs, across 3 regions. Run: node seed-a.mjs
import { tenant, defineModels, atom, index, A } from './seed-lib.mjs';

await defineModels();
await tenant('a', 'Demo A — PAC');

// an index over people, filtered by region
await index('peopleByRegion', 'People by region', 'atom://person',
  { region: { kind: 'ref', to: 'atom://region' } }, { region: 'params.region' }, [{ name: 'asc' }]);

const T = 'a';
const regionNames = ['North', 'South', 'West'];
for (let i = 0; i < 3; i++) await atom('region', `a-region-${i + 1}`, T, { name: regionNames[i] }, regionNames[i]);

// 1 director -> 3 regional managers (one per region) -> 16 staff
await atom('person', 'a-p1', T, { name: 'Dana Director', region: A('a-region-1') }, 'Dana Director');
for (let i = 0; i < 3; i++)
  await atom('person', `a-rm${i + 1}`, T, { name: `${regionNames[i]} Manager`, region: A(`a-region-${i + 1}`), manager: A('a-p1') }, `${regionNames[i]} Manager`);
const people = ['a-p1', 'a-rm1', 'a-rm2', 'a-rm3'];
for (let i = 1; i <= 16; i++) {
  const r = (i % 3) + 1;
  await atom('person', `a-s${i}`, T, { name: `Staffer ${i}`, region: A(`a-region-${r}`), manager: A(`a-rm${r}`) }, `Staffer ${i}`);
  people.push(`a-s${i}`);
}

// 100 fundraising transactions spread across the 20 people
for (let i = 0; i < 100; i++) {
  const p = people[i % people.length];
  const amount = 50 + (i * 37) % 4950;
  const month = String((i % 12) + 1).padStart(2, '0');
  await atom('fundraising', `a-tx${i + 1}`, T,
    { amount, donor: `Donor ${i + 1}`, person: A(p), at: `2026-${month}-15T12:00:00Z` },
    `$${amount} from Donor ${i + 1}`);
}

console.log('seed-a: PAC — 3 regions, 20 people, 100 transactions');

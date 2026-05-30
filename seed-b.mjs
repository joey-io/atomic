// Demo B — an advocacy program: stories shared by advocates from districts that
// each reference an elected official. Run: node seed-b.mjs
import { tenant, defineModels, atom, token, A } from './seed-lib.mjs';

await defineModels();
await tenant('b', 'Demo B — Advocacy');

// CapConnect: a one-click (open) login that can write only the advocate model
await token('capconnect', 'b', { email: 'capconnect@emailjoey.com', login: 'open', grants: [{ path: 'advocate.*', mode: 'write' }] });

const T = 'b';
const offices = ['Mayor', 'State Senator', 'US Representative', 'City Council', 'Governor'];
for (let i = 0; i < 5; i++) await atom('official', `b-off${i + 1}`, T, { name: `Hon. Official ${i + 1}`, office: offices[i] }, `Hon. Official ${i + 1}`);
for (let i = 0; i < 5; i++) await atom('district', `b-d${i + 1}`, T, { name: `District ${i + 1}`, official: A(`b-off${i + 1}`) }, `District ${i + 1}`);
for (let i = 0; i < 12; i++) await atom('advocate', `b-adv${i + 1}`, T, { name: `Advocate ${i + 1}`, district: A(`b-d${(i % 5) + 1}`) }, `Advocate ${i + 1}`);
for (let i = 0; i < 30; i++) {
  const adv = (i % 12) + 1;
  await atom('story', `b-st${i + 1}`, T,
    { title: `Why this matters #${i + 1}`, body: `An advocate shared a first-hand story about the impact in their district (#${i + 1}).`, advocate: A(`b-adv${adv}`) },
    `Why this matters #${i + 1}`);
}

console.log('seed-b: Advocacy — 5 officials, 5 districts, 12 advocates, 30 stories');

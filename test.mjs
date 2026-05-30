// Smoke test: boots the kernel on a temp port + temp store, exercises the
// load-bearing behaviour over HTTP, restarts to prove durability. No deps.
//   node test.mjs
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 7790, STORE = '/tmp/atomic-test-store', base = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`); };
const J = (tok, method, path, body) => fetch(base + path, {
  method, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const start = () => spawn('node', ['kernel.mjs'], { env: { ...process.env, PORT, ATOMIC_STORE: STORE }, stdio: 'ignore' });
async function wait() { for (let i = 0; i < 50; i++) { try { await fetch(base + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('no start'); }

rmSync(STORE, { recursive: true, force: true });
let srv = start(); await wait();

ok((await (await fetch(base + '/')).json()).id === '0', 'root is atom://0');

ok((await J('tok-amy', 'POST', '/contact', { attr: { name: 'x', email: 'bad' } })).status === 400, 'semantic email rejected');
ok((await J('tok-amy', 'POST', '/contact', { id: 't-good', attr: { name: 'G', email: 'g@acme.com', company: 'atom://northwind' } })).status === 201, 'valid contact created');

await J('joey', 'POST', '/token', { id: 'tok-mid', parent: 'atom://acme', attr: { email: 'm@acme.com', grants: [{ path: 'token.*', mode: 'write' }, { path: 'contact.*', mode: 'read' }] } });
ok((await J('tok-mid', 'POST', '/token', { attr: { email: 'a@acme.com', grants: [{ path: 'contact.*', mode: 'read' }] } })).status === 201, 'attenuation allows a subset grant');
ok((await J('tok-mid', 'POST', '/token', { attr: { email: 'b@acme.com', grants: [{ path: 'deal.*', mode: 'write' }] } })).status === 403, 'attenuation blocks a super-set grant');

await J('joey', 'POST', '/tenant', { id: 'gx', attr: { name: 'GX' } });
await J('joey', 'POST', '/token', { id: 'tok-gx', parent: 'atom://gx', attr: { email: 'g@gx.com', grants: [{ path: '**', mode: 'write' }] } });
await J('tok-gx', 'POST', '/contact', { id: 'gx-c', attr: { name: 'GX Lead', email: 'l@gx.com' } });
const amy = await (await J('tok-amy', 'GET', '/contact')).json();
const gx = await (await J('tok-gx', 'GET', '/contact')).json();
ok(!amy.find((c) => c.id === 'gx-c') && !!gx.find((c) => c.id === 'gx-c'), 'tenant isolation: gx data hidden from acme');

ok((await (await J('tok-amy', 'GET', '/contact?q=northwind')).json()).length > 0, 'full-text search matches');
ok((await (await J('tok-amy', 'GET', '/contact?q=zzznope')).json()).length === 0, 'full-text search empties');

srv.kill(); await new Promise((r) => setTimeout(r, 300));
srv = start(); await wait();
ok((await (await J('tok-amy', 'GET', '/t-good')).json())?.attr?.name === 'G', 'atom persists across restart');

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

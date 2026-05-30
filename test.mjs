// Smoke test: boots the kernel on a temp port + temp store, exercises the
// load-bearing behaviour over HTTP as the admin, restarts to prove durability.
// Self-contained — creates its own model/tenants. No deps. Run: node test.mjs
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
ok((await J('joey', 'POST', '/token', { attr: { email: 'bad', grants: [] } })).status === 400, 'semantic email rejected');

// admin sets up a model + two tenants + a member token in each
await J('joey', 'POST', '/model', { id: 'note', manifest: 'Note', attr: { label: 'Note', version: 1, fields: { text: { kind: 'text', required: true } } } });
await J('joey', 'POST', '/tenant', { id: 't1', attr: { name: 'T1' } });
await J('joey', 'POST', '/tenant', { id: 't2', attr: { name: 'T2' } });
await J('joey', 'POST', '/token', { id: 'tk1', parent: 'atom://t1', attr: { email: 'a@t1.com', grants: [{ path: '**', mode: 'write' }] } });
await J('joey', 'POST', '/token', { id: 'tk2', parent: 'atom://t2', attr: { email: 'b@t2.com', grants: [{ path: '**', mode: 'write' }] } });
ok((await J('tk1', 'POST', '/note', { id: 'n1', attr: { text: 'hello world' } })).status === 201, 'tenant member creates a note');

// attenuation: tk-mid can issue tokens but only holds note.* read
await J('joey', 'POST', '/token', { id: 'tk-mid', parent: 'atom://t1', attr: { email: 'm@t1.com', grants: [{ path: 'token.*', mode: 'write' }, { path: 'note.*', mode: 'read' }] } });
ok((await J('tk-mid', 'POST', '/token', { attr: { email: 'x@t1.com', grants: [{ path: 'note.*', mode: 'read' }] } })).status === 201, 'attenuation allows a subset grant');
ok((await J('tk-mid', 'POST', '/token', { attr: { email: 'y@t1.com', grants: [{ path: 'note.*', mode: 'write' }] } })).status === 403, 'attenuation blocks a super-set grant');

// tenant isolation
const s1 = await (await J('tk1', 'GET', '/note')).json();
const s2 = await (await J('tk2', 'GET', '/note')).json();
ok(!!s1.find((a) => a.id === 'n1') && !s2.find((a) => a.id === 'n1'), 'tenant isolation: t2 cannot see t1 data');

ok((await (await J('tk1', 'GET', '/note?q=hello')).json()).length > 0, 'full-text search matches');
ok((await (await J('tk1', 'GET', '/note?q=zzznope')).json()).length === 0, 'full-text search empties');

srv.kill(); await new Promise((r) => setTimeout(r, 300));
srv = start(); await wait();
ok((await (await J('tk1', 'GET', '/n1')).json())?.attr?.text === 'hello world', 'atom persists across restart');

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

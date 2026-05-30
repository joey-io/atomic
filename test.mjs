// Full-coverage smoke test. Boots the kernel on a temp port + temp store, drives
// the whole surface over HTTP as the admin and various scoped tokens, restarts to
// prove durability. Self-contained (creates its own models/tenants). No deps.
//   node test.mjs
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 7790, STORE = '/tmp/atomic-test-store', base = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`); };
const J = (tok, method, p, body, headers = {}) => fetch(base + p, {
  method, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), 'content-type': 'application/json', ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const code = (tok, method, p, body, h) => J(tok, method, p, body, h).then((r) => r.status);
const jsonOf = (tok, p) => J(tok, 'GET', p).then((r) => r.json());
const start = () => spawn('node', ['kernel.mjs'], { env: { ...process.env, PORT, ATOMIC_STORE: STORE, SENDGRID_API_KEY: '' }, stdio: 'ignore' });
async function wait() { for (let i = 0; i < 50; i++) { try { await fetch(base + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('no start'); }

rmSync(STORE, { recursive: true, force: true });
let srv = start(); await wait();

// --- root + anonymous --------------------------------------------------------
ok((await (await fetch(base + '/')).json()).id === '0', 'root is atom://0');
ok(await code(null, 'GET', '/widget') === 401, 'anonymous cannot read data');
ok((await (await fetch(base + '/style.css')).headers.get('content-type')) === 'text/css', 'style.css served');

// --- admin sets up a model, a hook, tenants, scoped tokens -------------------
await J('joey', 'POST', '/model', { id: 'tag', manifest: 'Tag', attr: { label: 'Tag', version: 1, fields: { label: { kind: 'text' } } } });
// the two hooks are capability atoms (no `on`); the model registers them in its lifecycle
await J('joey', 'POST', '/hook', { id: 'stamp', attr: { run: 'test-stamp', grants: [{ path: 'widget.stamp', mode: 'write' }] } });
await J('joey', 'POST', '/hook', { id: 'link', attr: { run: 'test-link', grants: [{ path: 'widget.tag', mode: 'write' }, { path: 'tag.*', mode: 'write' }] } });
await J('joey', 'POST', '/model', { id: 'widget', manifest: 'Widget', hooks: { create: ['atom://stamp', 'atom://link'] }, attr: { label: 'Widget', version: 1, fields: {
  name: { kind: 'text', required: true }, size: { kind: 'number', min: 0, max: 100 },
  kind: { kind: 'enum', values: ['a', 'b'] }, parentw: { kind: 'ref', to: 'atom://widget', inverse: 'children' },
  tag: { kind: 'ref', to: 'atom://tag', inverse: 'widgets' },
  stamp: { kind: 'text' }, email: { kind: 'email' },
}, indexes: { byName: { on: ['name'], role: 'identity' } } } });
// a reusable role: read widgets. tk-roled wears it instead of carrying grants inline.
await J('joey', 'POST', '/role', { id: 'role-reader', attr: { label: 'Reader', grants: [{ path: 'widget.*', mode: 'read' }] } });
await J('joey', 'POST', '/tenant', { id: 't1', attr: { name: 'T1' } });
await J('joey', 'POST', '/tenant', { id: 't2', attr: { name: 'T2' } });
const mk = (id, t, grants) => J('joey', 'POST', '/token', { id, parent: 'atom://' + t, attr: { email: `${id}@x.com`, grants } });
await mk('tk-all', 't1', [{ path: '**', mode: 'all' }]);
await mk('tk-read', 't1', [{ path: 'widget.*', mode: 'read' }]);
await mk('tk-name', 't1', [{ path: 'widget.name', mode: 'write' }]);          // write name only, no read
await mk('tk-stamp', 't1', [{ path: 'widget.name', mode: 'write' }, { path: 'stamp', mode: 'read' }]);
await mk('tk-link', 't1', [{ path: 'widget.name', mode: 'write' }, { path: 'link', mode: 'read' }]);
await mk('tk2', 't2', [{ path: '**', mode: 'all' }]);
await J('joey', 'POST', '/token', { id: 'tk-roled', parent: 'atom://t1', attr: { email: 'tk-roled@x.com', roles: ['atom://role-reader'] } });

// --- validation --------------------------------------------------------------
ok(await code('tk-all', 'POST', '/widget', { attr: {} }) === 400, 'required field enforced');
ok(await code('tk-all', 'POST', '/widget', { attr: { name: 'x', kind: 'z' } }) === 400, 'enum value enforced');
ok(await code('tk-all', 'POST', '/widget', { attr: { name: 'x', size: 999 } }) === 400, 'number max enforced');
ok(await code('tk-all', 'POST', '/widget', { attr: { name: 'x', email: 'bad' } }) === 400, 'semantic email enforced');
ok(await code('tk-all', 'POST', '/widget', { id: 'w1', attr: { name: 'Alpha', size: 5, kind: 'a' } }) === 201, 'valid create');

// --- permits: read / write / all --------------------------------------------
ok(await code('tk-name', 'POST', '/widget', { id: 'w2', attr: { name: 'Beta' } }) === 201, 'write-only token can create');
ok((await jsonOf('tk-name', '/widget')).length === 0, 'write-only token sees no list (no read)');
ok(await code('tk-name', 'GET', '/w1') === 404, 'write-only token cannot read a record');
ok((await jsonOf('tk-read', '/widget')).length >= 2, 'read token sees the list');
ok(await code('tk-read', 'POST', '/widget', { attr: { name: 'z' } }) === 403, 'read token cannot write');

// --- per-field redaction (tk-read has widget.* read; narrow to one field) ----
await mk('tk-nameonly', 't1', [{ path: 'widget.name', mode: 'read' }]);
ok(Object.keys((await jsonOf('tk-nameonly', '/w1')).attr).join() === 'name', 'redaction: only granted field visible');

// --- attenuation (token) -----------------------------------------------------
await mk('tk-mid', 't1', [{ path: 'token.*', mode: 'write' }, { path: 'widget.*', mode: 'read' }]);
ok(await code('tk-mid', 'POST', '/token', { attr: { email: 'a1@x.com', grants: [{ path: 'widget.*', mode: 'read' }] } }) === 201, 'attenuation: subset grant allowed');
ok(await code('tk-mid', 'POST', '/token', { attr: { email: 'a2@x.com', grants: [{ path: 'widget.*', mode: 'write' }] } }) === 403, 'attenuation: super-set grant blocked');

// --- tenant isolation --------------------------------------------------------
ok(!(await jsonOf('tk2', '/widget')).find((a) => a.id === 'w1'), 'tenant isolation: t2 cannot list t1 data');
ok(await code('tk2', 'GET', '/w1') === 404, 'tenant isolation: t2 cannot read a t1 record');
ok(await code('tk2', 'PATCH', '/w1', { attr: { name: 'hacked' } }) === 404, 'tenant isolation: t2 cannot write a t1 record');

// --- parent-on-create (provisioning) ----------------------------------------
ok(await code('joey', 'POST', '/widget', { id: 'w-t2', parent: 'atom://t2', attr: { name: 'In T2' } }) === 201, 'root can place into a tenant');
ok(await code('tk-all', 'POST', '/widget', { parent: 'atom://t2', attr: { name: 'x' } }) === 403, 'non-superuser cannot place cross-tenant');

// --- identity dedup / merge --------------------------------------------------
const before = (await jsonOf('tk-all', '/widget')).length;
await J('tk-all', 'POST', '/widget', { attr: { name: 'Alpha', kind: 'b' } }); // same byName -> merge into w1
ok((await jsonOf('tk-all', '/widget')).length === before, 'identity index merges instead of duplicating');
ok((await jsonOf('tk-all', '/w1')).attr.kind === 'b', 'merge updated the existing atom');

// --- write semantics: conflict / replace / update ----------------------------
ok(await code('tk-all', 'POST', '/widget', { id: 'w1', attr: { name: 'dupe' } }) === 409, 'POST existing id is a conflict');
const v = (await jsonOf('tk-all', '/w1')).lifecycle.version;
ok(await code('tk-all', 'PATCH', '/w1', { attr: { size: 9 } }, { 'if-match': String(v + 9) }) === 409, 'If-Match version conflict');
ok(await code('tk-all', 'PATCH', '/w1', { attr: { size: 9 } }) === 200, 'PATCH merges');
ok((await jsonOf('tk-all', '/w1')).attr.name === 'Alpha', 'PATCH kept other fields');

// --- delete (gated) ----------------------------------------------------------
await mk('tk-nodel', 't1', [{ path: 'widget.*', mode: 'read' }]); // read only -> no delete
ok(await code('tk-nodel', 'DELETE', '/w2') === 403, 'delete blocked without a mutating grant');
ok(await code('tk-all', 'DELETE', '/w2') === 200, 'delete with grant retires');
ok(!(await jsonOf('tk-all', '/widget')).find((a) => a.id === 'w2'), 'retired atom hidden from list');

// --- hooks (model-registered in lifecycle; run under own grants, no invoke) --
await J('tk-stamp', 'POST', '/widget', { id: 'w-hook', attr: { name: 'Gamma' } });
ok((await jsonOf('joey', '/w-hook')).attr.stamp === 'ok', 'model hook wrote a field under its own grant');
ok(await code('tk-stamp', 'POST', '/widget', { attr: { name: 'z2', stamp: 'no' } }) === 403, 'caller cannot write the hook-only field directly');
await J('tk-name', 'POST', '/widget', { id: 'w-anyone', attr: { name: 'Delta' } });
ok((await jsonOf('joey', '/w-anyone')).attr.stamp === 'ok', 'model hook runs for any authorized writer (no invoke grant needed)');

// --- hook upsert + link (the census/district pattern) ------------------------
await J('tk-link', 'POST', '/widget', { id: 'w-link', attr: { name: 'Echo' } });
ok((await jsonOf('joey', '/w-link')).attr.tag === 'atom://tag-echo', 'hook upserts a related atom and links it');
ok((await jsonOf('joey', '/tag-echo')).attr.label === 'Echo', 'the upserted atom exists');
ok(await code('tk-link', 'POST', '/widget', { attr: { name: 'zz', tag: 'atom://tag-x' } }) === 403, 'caller cannot set the hook-linked ref directly');

// --- roles: a token inherits grants from referenced role atoms ---------------
ok((await jsonOf('tk-roled', '/widget')).length >= 1, 'token inherits read grant from its role');
ok(await code('tk-roled', 'POST', '/widget', { attr: { name: 'nope' } }) === 403, 'role grants do not exceed what the role holds');

// --- links render only when the target is reachable --------------------------
await J('tk-all', 'POST', '/widget', { id: 'w-dang', attr: { name: 'Dangling', parentw: 'atom://ghost' } });
const dh = await (await J('joey', 'GET', '/w-dang?as=html', null, { accept: 'text/html' })).text();
ok(dh.includes('atom://ghost') && !dh.includes('href="/ghost"'), 'ref to a missing atom is plain text, not a link');

// --- path traversal + inverse edges ------------------------------------------
await J('tk-all', 'POST', '/widget', { id: 'wp', attr: { name: 'Parent' } });
await J('tk-all', 'POST', '/widget', { id: 'wc', attr: { name: 'Child', parentw: 'atom://wp' } });
ok((await (await J('tk-all', 'GET', '/wc.parentw.name')).json()) === 'Parent', 'path traversal across a ref');
ok((await (await J('tk-all', 'GET', '/wp.children')).json()).includes('atom://wc'), 'inverse edge resolves');

// --- ref map -----------------------------------------------------------------
ok((await (await J('joey', 'GET', '/wp?as=html', null, { accept: 'text/html' })).text()).includes('referenced by'), 'atom view shows a ref map');

// --- full-text + pagination --------------------------------------------------
ok((await jsonOf('tk-all', '/widget?q=Alpha')).length > 0, 'full-text matches');
ok((await jsonOf('tk-all', '/widget?q=zzznope')).length === 0, 'full-text empties');
ok((await jsonOf('joey', '/recent?limit=1')).length === 1, 'index pagination limit');

// --- sessions: open login + magic link + logout ------------------------------
await J('joey', 'PATCH', '/tk-read', { attr: { login: 'open' } }); // tk-read can't patch itself; do as joey
const openR = await fetch(base + '/auth/open?token=tk-read', { redirect: 'manual' });
const cookie = (openR.headers.get('set-cookie') || '').split(';')[0];
ok(!!cookie && (await fetch(base + '/widget', { headers: { cookie } })).status === 200, 'open-login cookie authenticates');
const link = (await (await J(null, 'POST', '/auth', { email: 'tk-all@x.com' })).json()).link;
ok(!!link, 'magic link issued (dev fallback shows link)');
const ver = await fetch(base + link.slice(base.length), { redirect: 'manual' });
ok((ver.headers.get('set-cookie') || '').includes('atomic_session'), 'magic link verifies into a session');

// --- persistence across restart ----------------------------------------------
srv.kill(); await new Promise((r) => setTimeout(r, 300));
srv = start(); await wait();
ok((await jsonOf('joey', '/w1')).attr.name === 'Alpha', 'atom persists across restart');
ok((await jsonOf('joey', '/w-hook')).attr.stamp === 'ok', 'hook-written field persists');

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

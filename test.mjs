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
const start = () => spawn('node', ['atomic.mjs'], { env: { ...process.env, PORT, ATOMIC_STORE: STORE, SENDGRID_API_KEY: '' }, stdio: 'ignore' });
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
await mk('tk-name', 't1', [{ path: 'widget.name', mode: 'write' }]); // write name only, no read
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
ok((await jsonOf('joey', '/atom.byDate?limit=1')).length === 1, 'index pagination limit');

// --- sessions: open login + magic link + logout ------------------------------
await J('joey', 'PATCH', '/tk-read', { attr: { login: 'open' } }); // tk-read can't patch itself; do as joey
const openR = await fetch(base + '/auth/open?token=tk-read', { redirect: 'manual' });
const cookie = (openR.headers.get('set-cookie') || '').split(';')[0];
ok(!!cookie && (await fetch(base + '/widget', { headers: { cookie } })).status === 200, 'open-login cookie authenticates');
const link = (await (await J(null, 'POST', '/auth', { email: 'tk-all@x.com' })).json()).link;
ok(!!link, 'magic link issued (dev fallback shows link)');
const ver = await fetch(base + link.slice(base.length), { redirect: 'manual' });
ok((ver.headers.get('set-cookie') || '').includes('atomic_session'), 'magic link verifies into a session');

// --- access invariants: the tree decides who may write ----------------------
// global/root atoms are root-only: a tenant user can't write one even WITH the grant
await J('joey', 'POST', '/config', { id: 'cfg-g', parent: 'atom://0', attr: { key: 'k', value: 1 } });
await mk('tk-cfg', 't1', [{ path: 'config.*', mode: 'all' }]);
ok(await code('tk-cfg', 'PATCH', '/cfg-g', { attr: { key: 'x' } }) === 403, 'tenant user cannot write a global atom');
ok(await code('tk-cfg', 'DELETE', '/cfg-g') === 403, 'tenant user cannot delete a global atom');
ok(await code('tk-cfg', 'POST', '/config', { parent: 'atom://0', attr: { key: 'y', value: 2 } }) === 403, 'tenant user cannot create into the global scope');
ok(await code('joey', 'PATCH', '/cfg-g', { attr: { key: 'z' } }) === 200, 'root can write a global atom');
// creator-owns: defining a type lets the definer immediately instantiate it
await mk('tk-maker', 't1', [{ path: 'model.*', mode: 'all' }]);
ok(await code('tk-maker', 'POST', '/model', { id: 'gizmo', attr: { label: 'Gizmo', version: 1, fields: { n: { kind: 'text' } } } }) === 201, 'tenant user can define a type');
ok(await code('tk-maker', 'POST', '/gizmo', { attr: { n: 'a' } }) === 201, 'creator-owns: definer can instantiate the new type');
ok(await code('tk2', 'GET', '/gizmo') === 404, 'a tenant-scoped type is invisible to another tenant');
ok(await code('joey', 'PATCH', '/gizmo', { attr: { label: 'Gizmo2' } }) === 200, 'root can write a tenant atom');
// hooks: run is locked to a safe basename (no path-traversal import)
ok(await code('joey', 'POST', '/hook', { id: 'h-bad', attr: { run: '../../x', grants: [] } }) === 400, 'hook run rejects path traversal');
// sessions are bearer credentials, never served through the surface
ok(await code('joey', 'GET', '/' + cookie.split('=')[1]) === 404, 'a session atom is unreadable, even by root');

// --- schema migration: version-bump rewrite on read -------------------------
// gadget v1: a record written under the old shape, then evolved forward by a
// chain of migrations (rename → default → custom). The kernel brings it forward.
await J('joey', 'POST', '/model', { id: 'gadget', attr: { label: 'Gadget', version: 1, fields: {
  title: { kind: 'text', required: true }, label: { kind: 'text' } } } });
await J('joey', 'POST', '/gadget', { id: 'g1', attr: { title: 'Hello World', label: 'old value' } });
ok((await jsonOf('joey', '/g1')).lifecycle.modelVersion === 1, 'record is born at the model version (1)');

// v2 — rename `label` → `name` (a kernel `rename` op). Ship the new model def, then the migration.
await J('joey', 'PUT', '/gadget', { attr: { label: 'Gadget', version: 2, fields: {
  title: { kind: 'text', required: true }, name: { kind: 'text' } } } });
await J('joey', 'POST', '/migration', { id: 'gadget@1-2', attr: { model: 'atom://gadget', from: 1, to: 2, op: 'rename', spec: { from: 'label', to: 'name' } } });
let g = await jsonOf('joey', '/g1');
ok(g.attr.name === 'old value' && g.attr.label === undefined, 'migration: rename moved label → name');
ok(g.lifecycle.modelVersion === 2, 'migration bumped modelVersion to 2');

// v3 — add `status` with a default (a kernel `default` op)
await J('joey', 'PUT', '/gadget', { attr: { label: 'Gadget', version: 3, fields: {
  title: { kind: 'text', required: true }, name: { kind: 'text' }, status: { kind: 'text' } } } });
await J('joey', 'POST', '/migration', { id: 'gadget@2-3', attr: { model: 'atom://gadget', from: 2, to: 3, op: 'default', spec: { field: 'status', value: 'active' } } });
ok((await jsonOf('joey', '/g1')).attr.status === 'active', 'migration: default filled the new field');

// v4 — a custom handler derives `slug` from `title` (scripts/test-migrate.mjs)
await J('joey', 'PUT', '/gadget', { attr: { label: 'Gadget', version: 4, fields: {
  title: { kind: 'text', required: true }, name: { kind: 'text' }, status: { kind: 'text' }, slug: { kind: 'text' } } } });
await J('joey', 'POST', '/migration', { id: 'gadget@3-4', attr: { model: 'atom://gadget', from: 3, to: 4, op: 'custom', run: 'test-migrate' } });
g = await jsonOf('joey', '/g1');
ok(g.attr.slug === 'hello-world' && g.lifecycle.modelVersion === 4, 'migration: custom handler computed slug, version now 4');
// migration rewrites the record — the rewrite is logged as a `migrate` op
ok((await jsonOf('joey', '/log.byAtom?atom=atom://g1')).some((l) => l.attr.op === 'migrate'), 'migration rewrite is recorded in the ledger');
// a migration run name is locked to a safe basename (no path-traversal import)
ok(await code('joey', 'POST', '/migration', { id: 'mig-bad', attr: { model: 'atom://gadget', from: 9, to: 10, op: 'custom', run: '../../x' } }) === 400, 'migration run rejects path traversal');

// --- security regressions ----------------------------------------------------
// H1: a dotted path is a read like any other — it must honor tenant scope, the
// per-attribute read grant, and rules, exactly like the whole-atom view.
ok((await (await J('tk-all', 'GET', '/w1.name')).json()) === 'Alpha', 'path read of a visible field works');
ok(await code('tk2', 'GET', '/w1.name') === 404, 'path read cannot cross tenant (t2 → t1 atom)');
ok(await code('tk-nameonly', 'GET', '/w1.size') === 404, 'path read is redacted (no grant on widget.size)');
ok((await (await J('tk-nameonly', 'GET', '/w1.name')).json()) === 'Alpha', 'path read of a granted field still works');
ok(await code('tk-read', 'GET', '/joey.email') === 404, 'path read cannot leak another token’s field');
ok(await code('tk-read', 'GET', '/joey.grants') === 404, 'path read cannot leak another token’s grants');

// H2: roles are attenuated too — a token cannot wear a role that grants more than
// the issuer holds (else "mint a ** role, then wear it" bypasses attenuation).
await J('joey', 'POST', '/role', { id: 'role-admin', attr: { label: 'Admin', grants: [{ path: '**', mode: 'all' }] } });
ok(await code('tk-mid', 'POST', '/token', { attr: { email: 'r1@x.com', roles: ['atom://role-admin'] } }) === 403, 'attenuation: cannot wear a role exceeding own grants');
ok(await code('tk-mid', 'POST', '/token', { attr: { email: 'r2@x.com', roles: ['atom://role-reader'] } }) === 201, 'attenuation: a role within own grants is allowed');

// global system tokens are superuser-only: even a token-read grant can't surface
// the root admin token to a tenant user (it isn't shared reference data).
await mk('tk-tokread', 't1', [{ path: 'token.*', mode: 'read' }]);
ok(await code('tk-tokread', 'GET', '/joey') === 404, 'tenant user with token-read cannot see the global admin token');
ok(await code('tk-tokread', 'GET', '/joey.email') === 404, 'nor read its fields via a path');
ok(await code('joey', 'GET', '/joey') === 200, 'a superuser still sees the admin token');

// M2: retiring a token revokes its Bearer credential immediately.
await mk('tk-revoke', 't1', [{ path: 'widget.*', mode: 'read' }]);
ok(await code('tk-revoke', 'GET', '/widget') === 200, 'live token reads');
await J('joey', 'DELETE', '/tk-revoke');
ok(await code('tk-revoke', 'GET', '/widget') === 401, 'retired token no longer authenticates (Bearer)');

// M3: a malformed migration (to <= from) cannot loop-rewrite the record on every read.
await J('joey', 'PUT', '/gadget', { attr: { label: 'Gadget', version: 5, fields: {
  title: { kind: 'text', required: true }, name: { kind: 'text' }, status: { kind: 'text' }, slug: { kind: 'text' } } } });
await J('joey', 'POST', '/migration', { id: 'gadget@bad', attr: { model: 'atom://gadget', from: 4, to: 4, op: 'default', spec: { field: 'noop', value: 1 } } });
const lz = (await jsonOf('joey', '/log.byAtom?atom=atom://g1')).length;
await jsonOf('joey', '/g1'); await jsonOf('joey', '/g1'); await jsonOf('joey', '/g1');
ok((await jsonOf('joey', '/log.byAtom?atom=atom://g1')).length === lz && (await jsonOf('joey', '/g1')).lifecycle.modelVersion === 4, 'malformed migration is inert — no rewrite-on-read loop');

// M4: an oversized request body is rejected, not buffered to exhaustion.
ok(await code('joey', 'POST', '/widget', { attr: { name: 'x'.repeat(9 * 1024 * 1024) } }) === 413, 'oversized body rejected with 413');

// L1: a self-embedding model renders without overflowing the stack.
await J('joey', 'POST', '/model', { id: 'loopy', attr: { label: 'Loopy', version: 1, fields: { self: 'embed://loopy', n: { kind: 'text' } } } });
ok((await J('joey', 'GET', '/loopy', null, { accept: 'text/html' })).status === 200, 'self-embedding model page renders (no stack overflow)');

// L2: an id with HTML/URL metacharacters is rejected.
ok(await code('joey', 'POST', '/widget', { id: '<script>', attr: { name: 'x' } }) === 400, 'unsafe id rejected');

// --- persistence across restart ----------------------------------------------
srv.kill(); await new Promise((r) => setTimeout(r, 300));
srv = start(); await wait();
ok((await jsonOf('joey', '/w1')).attr.name === 'Alpha', 'atom persists across restart');
ok((await jsonOf('joey', '/w-hook')).attr.stamp === 'ok', 'hook-written field persists');
// the migrated shape is durable — the rewrite was persisted, not recomputed each read
g = await jsonOf('joey', '/g1');
ok(g.attr.name === 'old value' && g.attr.status === 'active' && g.attr.slug === 'hello-world' && g.lifecycle.modelVersion === 4, 'migrated shape persists across restart');

srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

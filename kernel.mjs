// Atomic — the most minimal kernel.
//
// One store of atoms. The schema is atoms. Identity is a token atom.
// CRUD is the ledger. The HTTP surface is generated from the atoms.
//
// Dependency-free. Run: node kernel.mjs   (Node >= 18)
//
// This is a teaching kernel: in-memory, resets on restart. It implements
// the load-bearing ideas from the README and leaves room marked TODO where
// the spec goes deeper (rule predicates, migrations, embed validation depth).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// load ./.env (KEY=VALUE lines) into process.env as a fallback — no dependency,
// explicit env still wins. This is where ATOMIC_STORE / SENDGRID_API_KEY live.
try {
  for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }

// ---------------------------------------------------------------------------
// Store + ledger
// ---------------------------------------------------------------------------

const CSS = (() => { try { return fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8'); } catch { return ''; } })();
const store = new Map();      // id -> atom
let   logSeq = 0;             // ledger sequence
const invReg = {};            // inverseName -> { sourceModel, field, targetModel }

const now = () => new Date().toISOString();
const isRef = (v) => typeof v === 'string' && v.startsWith('atom://');
const refId = (v) => v.slice('atom://'.length);
const ref   = (id) => `atom://${id}`;

class Err extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function getAtom(id) {
  const a = store.get(id);
  if (!a) throw new Err(404, `no atom ${id}`);
  return a;
}
const isAtomObj = (n) => n && typeof n === 'object' && 'model' in n && 'attr' in n;

// Put an atom straight into the store (bootstrap / seed — bypasses checks).
function seed(atom) { store.set(atom.id, atom); persist(atom); return atom; }

// ---------------------------------------------------------------------------
// Inverse-edge registry (built from model atoms)
// ---------------------------------------------------------------------------

function buildInverse() {
  for (const k of Object.keys(invReg)) delete invReg[k];
  for (const a of store.values()) {
    if (a.model !== 'atom://model') continue;
    const fields = a.attr.fields || {};
    for (const [field, def] of Object.entries(fields)) {
      if (def && typeof def === 'object' && def.kind === 'ref' && def.inverse) {
        invReg[def.inverse] = {
          sourceModel: a.id,
          field,
          targetModel: refId(def.to),
        };
      }
    }
  }
}

function inverseList(targetId, inv) {
  const out = [];
  for (const a of store.values()) {
    if (a.model === ref(inv.sourceModel) &&
        a.lifecycle?.status !== 'retired' &&
        a.attr?.[inv.field] === ref(targetId)) {
      out.push(ref(a.id));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path resolution: read across fields, edges, and inverse edges
// ---------------------------------------------------------------------------

const deref = (node) => (isRef(node) ? getAtom(refId(node)) : node);

function readField(node, seg) {
  if (node == null) throw new Err(404, `null before .${seg}`);
  if (Array.isArray(node)) return node.map((n) => readField(deref(n), seg));
  if (isAtomObj(node)) {
    if (node.attr && seg in node.attr) return node.attr[seg];
    if (node.lifecycle && typeof node.lifecycle === 'object' && seg in node.lifecycle)
      return node.lifecycle[seg];
    const inv = invReg[seg];
    if (inv && inv.targetModel === refId(node.model)) return inverseList(node.id, inv);
    throw new Err(404, `no field .${seg} on ${node.id}`);
  }
  if (typeof node === 'object') return node[seg];
  throw new Err(404, `cannot read .${seg} of a scalar`);
}

function traverse(start, segs) {
  if (segs.length > 16) throw new Err(400, 'path exceeds traversal budget'); // budget/cycle guard
  let node = start;
  for (const seg of segs) node = readField(deref(node), seg);
  return node; // final value left un-dereferenced (a ref stays a ref)
}

// ---------------------------------------------------------------------------
// Validation: an atom's attr against its model's fields (Zod-style)
// ---------------------------------------------------------------------------

function validate(modelId, attr) {
  const m = getAtom(modelId);
  if (m.model !== 'atom://model') throw new Err(400, `${modelId} is not a model`);
  const fields = m.attr.fields || {};
  const out = {};
  for (const [key, def] of Object.entries(fields)) {
    // embed://x shorthand — inline another model's fields
    if (typeof def === 'string' && def.startsWith('embed://')) {
      const sub = def.slice('embed://'.length);
      if (attr[key] !== undefined) out[key] = validate(sub, attr[key]); // returns plain object
      continue;
    }
    let val = attr[key];
    if (val === undefined && 'default' in def) val = def.default;
    if (val === undefined) {
      if (def.required) throw new Err(400, `missing required field "${key}"`);
      continue;
    }
    checkKind(key, def, val);
    out[key] = val;
  }
  return out;
}

// semantic string formats, like Zod's z.string().email() / .url() / .uuid()
const FORMATS = {
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  url: /^https?:\/\/\S+$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};
function checkKind(key, def, val) {
  const fail = (want) => { throw new Err(400, `field "${key}" must be ${want}`); };
  const str = () => { if (typeof val !== 'string') fail('text'); };
  const len = () => {
    if (def.minLength != null && val.length < def.minLength) fail(`at least ${def.minLength} characters`);
    if (def.maxLength != null && val.length > def.maxLength) fail(`at most ${def.maxLength} characters`);
    if (def.pattern && !new RegExp(def.pattern).test(val)) fail(`to match ${def.pattern}`);
  };
  const range = () => {
    if (def.min != null && val < def.min) fail(`>= ${def.min}`);
    if (def.max != null && val > def.max) fail(`<= ${def.max}`);
  };
  switch (def.kind) {
    case 'text': case 'longtext': str(); len(); break;
    case 'email': str(); if (!FORMATS.email.test(val)) fail('an email'); break;
    case 'url': str(); if (!FORMATS.url.test(val)) fail('a URL'); break;
    case 'uuid': str(); if (!FORMATS.uuid.test(val)) fail('a UUID'); break;
    case 'integer': if (!Number.isInteger(val)) fail('an integer'); range(); break;
    case 'number': if (typeof val !== 'number') fail('a number'); range(); break;
    case 'boolean': if (typeof val !== 'boolean') fail('a boolean'); break;
    case 'datetime': str(); if (isNaN(Date.parse(val))) fail('a datetime'); break;
    case 'enum': if (!def.values?.includes(val)) fail(`one of ${def.values?.join(', ')}`); break;
    case 'ref': if (!isRef(val)) fail('an atom:// reference'); break;
    case 'list': if (!Array.isArray(val)) fail('a list'); break;
    case 'map': case 'json': if (typeof val !== 'object') fail('an object'); break;
    default: /* unknown kind: accept */ break;
  }
}

// ---------------------------------------------------------------------------
// Identity / dedup
// ---------------------------------------------------------------------------

function identityIndexes(modelAtom) {
  const ix = modelAtom.attr.indexes || {};
  return Object.values(ix).filter((i) => i.role === 'identity');
}

function findByIdentity(modelId, attr, modelAtom) {
  for (const idx of identityIndexes(modelAtom)) {
    const keyFields = idx.on;
    if (keyFields.some((f) => attr[f] === undefined)) continue;
    for (const a of store.values()) {
      if (a.model !== ref(modelId) || a.lifecycle?.status === 'retired') continue;
      if (keyFields.every((f) => a.attr[f] === attr[f])) return a;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tokens, grants, redaction
// ---------------------------------------------------------------------------

const magic = new Map(); // one-time sign-in codes: code -> { token, exp }

// Magic-link delivery via SendGrid. The key is read from the environment
// (ATOMIC reuses MondayDraft's SendGrid in our env); unset -> dev fallback
// that shows the link instead of emailing it.
const SENDGRID = process.env.SENDGRID_API_KEY || null;
const MAIL_FROM = process.env.ATOMIC_MAIL_FROM || 'hello@mondaydraft.com';
async function sendMagicLink(to, link) {
  if (!SENDGRID) return false;
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + SENDGRID, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: MAIL_FROM, name: 'Atomic' },
        subject: 'Your Atomic sign-in link',
        content: [
          { type: 'text/plain', value: `Sign in to Atomic:\n${link}\n\nThis link expires in 15 minutes.` },
          { type: 'text/html', value: `<p>Sign in to Atomic:</p><p><a href="${link}">${link}</a></p><p>Expires in 15 minutes.</p>` },
        ],
      }),
    });
    return r.ok;
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The actor is resolved from a tracked session (cookie) or a bearer token.
// An unauthenticated request resolves to atom://0 — the anonymous identity,
// which can read the app descriptor but holds no data grants.
function actorFromReq(req, cookies) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);              // integrations present a token directly
  if (m && store.has(m[1])) return getAtom(m[1]);
  const sid = cookies['atomic_session'];                 // browsers carry a session the kernel tracks
  if (sid && store.has(sid)) {
    const s = store.get(sid);
    if (s.model === 'atom://session' && s.lifecycle.status === 'active' &&
        (!s.attr.expiresAt || s.attr.expiresAt > now()) && store.has(refId(s.attr.token)))
      return getAtom(refId(s.attr.token));
  }
  return getAtom('0'); // atom://0 — the anonymous identity (no data grants)
}

// A session is an atom too — it binds a cookie id to the token it authenticates.
function newSession(tokenId) {
  const id = `sess-${randomUUID().slice(0, 8)}`;
  seed({
    id, model: 'atom://session', manifest: `session for ${tokenId}`,
    attr: { token: ref(tokenId), createdAt: now(), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(tokenId) },
  });
  return id;
}

// a token's effective grants = its own grants + the grants of every role it
// references. A role atom is just a reusable bundle of grants (see canSee/role).
const grantsOf = (actor) => [
  ...(actor.attr?.grants || []),
  ...(actor.attr?.roles || []).flatMap((r) => store.get(isRef(r) ? refId(r) : r)?.attr?.grants || []),
];

// segment-wise match with * (one segment) and ** (any number)
function grantMatch(gpath, target) {
  const g = gpath.split('.'), t = target.split('.');
  const go = (gi, ti) => {
    if (gi === g.length) return ti === t.length;
    if (g[gi] === '**') {
      for (let i = ti; i <= t.length; i++) if (go(gi + 1, i)) return true;
      return false;
    }
    if (ti === t.length) return false;
    if (g[gi] === '*' || g[gi] === t[ti]) return go(gi + 1, ti + 1);
    return false;
  };
  return go(0, 0);
}

// The HTTP methods are the auth schema. A grant's mode is the operation it
// permits; the method maps to one. `write` is the mutation superset, and any
// grant implies read (if you can touch it, you can see it).
const OP = { GET: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
// `all` = everything; `read` reads; `write` = create+update+delete (NOT read);
// create/update/delete = just that op. read is its own grant — write-only can't read.
const permits = (mode, op) =>
  mode === 'all' ? true : op === 'read' ? mode === 'read' : mode === 'write' ? true : mode === op;

// field-level: may the actor do `op` on this path (model.field, index, ...)?
const allows = (actor, target, op) =>
  grantsOf(actor).some((x) => permits(x.mode, op) && grantMatch(x.path, target));
// model-level: may the actor do `op` on this model/index as a whole?
const canOp = (actor, name, op) =>
  grantsOf(actor).some((x) => { const s = x.path.split('.')[0]; return (s === name || s === '*' || s === '**') && permits(x.mode, op); });
// nav visibility: does the actor hold any grant touching this name?
const canTouch = (actor, name) =>
  grantsOf(actor).some((x) => { const s = x.path.split('.')[0]; return s === name || s === '*' || s === '**'; });
const canRead = (actor, target) => allows(actor, target, 'read');

// Attenuation: a token may only be issued with grants that are a subset of the
// issuer's own — it can never grant more than it holds.
function attenuate(actor, modelId, attr) {
  if (!['token', 'hook'].includes(modelId) || !Array.isArray(attr.grants)) return;
  for (const cg of attr.grants)
    if (!grantsOf(actor).some((g) => grantMatch(g.path, cg.path) && permits(g.mode, cg.mode)))
      throw new Err(403, `cannot grant ${cg.mode} ${cg.path}: it exceeds your own grants`);
}

// A model's rules.read/write are path-expression predicates evaluated against
// the actor and the atom. A safe evaluator — no eval: only literals, equality,
// and path reads. Anything it can't parse denies (access is never granted by error).
function resolveSide(s, actor, atom) {
  s = s.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('atom://')) return s;
  const segs = s.split('.');
  let base = atom;
  if (segs[0] === 'actor') { base = actor; segs.shift(); }
  try { return segs.length ? traverse(base, segs) : (base && base.id ? ref(base.id) : base); }
  catch { return undefined; }
}
function evalRule(pred, actor, atom) {
  if (pred == null || pred === 'true' || pred === true) return true;
  if (pred === 'false' || pred === false) return false;
  const m = String(pred).match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (!m) return false;
  const l = resolveSide(m[1], actor, atom), r = resolveSide(m[3], actor, atom);
  return m[2] === '==' ? l === r : l !== r;
}
const ruleOk = (actor, atom, which) =>
  evalRule(getAtom(refId(atom.model)).attr.rules?.[which], actor, atom);

// the tenant is the parent atom: an atom's tenant is its nearest tenant ancestor
// (walk lifecycle.parent). Global atoms (the core models) have none.
function tenantOf(atom) {
  let cur = atom;
  for (let hops = 0; cur && hops < 8; hops++) {
    if (cur.model === 'atom://tenant') return cur.id;
    const p = cur.lifecycle?.parent;
    if (!isRef(p) || refId(p) === cur.id) return null;
    cur = store.get(refId(p));
  }
  return null;
}
// a global atom is visible to all; otherwise the actor must share its tenant
function visible(actor, atom) {
  const at = tenantOf(atom), ut = tenantOf(actor);
  return at === null || ut === null || at === ut;
}

// ---------------------------------------------------------------------------
// Sharded store seam. getStore(actor).all() yields the atoms in the actor's
// scope: the global (core) atoms plus its own tenant's. Every multi-atom read
// goes through here, so the tenant boundary lives in one place. In this kernel
// it filters a single in-memory Map; a sharded build swaps this for one store
// per tenant (e.g. SQLite/LMDB opened lazily, with the core models replicated).
// ---------------------------------------------------------------------------
function getStore(actor) {
  return { all: () => [...store.values()].filter((a) => visible(actor, a)) };
}

// ---------------------------------------------------------------------------
// Durability. Each tenant is a shard on disk: an append-only NDJSON log under
// ATOMIC_STORE/<tenant>/log.ndjson. State is the fold of the log, replayed on
// boot. Per-tenant files give physical isolation (a node serves one tenant's
// file); unset ATOMIC_STORE keeps the kernel pure in-memory (the demo).
// ---------------------------------------------------------------------------
const ROOT = process.env.ATOMIC_STORE || null;
const shardOf = (atom) => tenantOf(atom) || '_global';
function persist(atom) {
  if (!ROOT) return;
  const dir = path.join(ROOT, shardOf(atom));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'log.ndjson'), JSON.stringify(atom) + '\n');
}
function loadAll() {
  if (!ROOT || !fs.existsSync(ROOT)) return false;
  let n = 0;
  for (const shard of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, shard, 'log.ndjson');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n'))
      if (line.trim()) { const a = JSON.parse(line); store.set(a.id, a); n++; }
  }
  return n > 0;
}

function redact(actor, atom) {
  if (atom.id === '0') return atom; // the public root atom — the address everyone sees
  const modelId = refId(atom.model);
  const attr = {};
  for (const [k, v] of Object.entries(atom.attr || {})) {
    if (canRead(actor, `${modelId}.${k}`)) attr[k] = v;
  }
  return { ...atom, attr };
}

// ---------------------------------------------------------------------------
// Write path: create / update / delete  (every write appends to the ledger)
// ---------------------------------------------------------------------------

function logIt(atomId, op, actorId, changes) {
  const id = `log-${++logSeq}`;
  const subj = store.get(atomId);
  seed({
    id, model: 'atom://log', manifest: `${op} ${atomId}`,
    attr: { atom: ref(atomId), op, actor: ref(actorId), at: now(), changes },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(),
      createdBy: ref(actorId), parent: ref(subj ? (tenantOf(subj) || '0') : '0') },
  });
}

function changeset(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const k of keys) if (before?.[k] !== after?.[k])
    changes.push({ path: k, from: before?.[k] ?? null, to: after?.[k] ?? null });
  return changes;
}

function create(modelId, body, actor) {
  const modelAtom = getAtom(modelId);
  const fields = Object.keys(body.attr || {});
  if (!fields.every((f) => allows(actor, `${modelId}.${f}`, 'create')))
    throw new Err(403, `${actor.id} cannot create ${modelId}`);

  // POST creates. An explicit id that already exists is a conflict — never clobber.
  if (body.id && store.has(body.id))
    throw new Err(409, `atom ${body.id} exists — PATCH /${body.id} to update, PUT /${body.id} to replace`);

  const attr = validate(modelId, body.attr || {});
  attenuate(actor, modelId, attr);

  // identity dedup -> merge instead of duplicate
  const existing = findByIdentity(modelId, attr, modelAtom);
  if (existing) {
    const before = { ...existing.attr };
    const merge = modelAtom.attr.behavior?.merge || 'merge';
    existing.attr = merge === 'replace' ? attr : { ...existing.attr, ...attr };
    existing.lifecycle.version++;
    existing.lifecycle.updatedAt = now();
    existing.lifecycle.updatedBy = ref(actor.id);
    persist(existing);
    logIt(existing.id, 'merge', actor.id, changeset(before, existing.attr));
    return existing;
  }

  // by default an atom is born into the creator's tenant; an authorized caller
  // may place it under a chosen parent (e.g. root provisioning a new tenant)
  let parentId = tenantOf(actor) || '0';
  if (body.parent && isRef(body.parent)) {
    const target = getAtom(refId(body.parent));
    if (tenantOf(actor) !== null && !visible(actor, target))
      throw new Err(403, `${actor.id} cannot place into ${body.parent}`);
    parentId = refId(body.parent);
  }
  const id = body.id || randomUUID().slice(0, 8);
  const atom = {
    id, model: ref(modelId),
    manifest: body.manifest || '',
    attr,
    lifecycle: {
      status: 'active', version: 1,
      modelVersion: modelAtom.attr.version || 1,
      createdAt: now(), createdBy: ref(actor.id), parent: ref(parentId),
      ...(body.hooks ? { hooks: body.hooks } : {}), // hooks registered on this atom
    },
  };
  if (!evalRule(modelAtom.attr.rules?.write, actor, atom))
    throw new Err(403, `write rule denies create of ${modelId}`);
  seed(atom);
  if (modelId === 'model') buildInverse(); // a new model may declare inverse edges
  logIt(id, 'create', actor.id, changeset({}, attr));
  return atom;
}

function update(id, body, actor, ifMatch) {
  const atom = getAtom(id);
  if (!visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  const modelId = refId(atom.model);
  const fields = Object.keys(body.attr || {});
  if (!fields.every((f) => allows(actor, `${modelId}.${f}`, 'update')))
    throw new Err(403, `${actor.id} cannot update ${modelId}`);
  if (ifMatch != null && Number(ifMatch) !== atom.lifecycle.version)
    throw new Err(409, `version conflict: have ${atom.lifecycle.version}, sent ${ifMatch}`);

  const before = { ...atom.attr };
  atom.attr = validate(modelId, { ...atom.attr, ...body.attr });
  attenuate(actor, modelId, atom.attr);
  if (!ruleOk(actor, atom, 'write')) throw new Err(403, `write rule denies update of ${modelId}`);
  if (body.hooks) atom.lifecycle.hooks = body.hooks; // (re)register lifecycle hooks
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(actor.id);
  persist(atom);
  logIt(id, 'update', actor.id, changeset(before, atom.attr));
  return atom;
}

// PUT — replace an existing atom's attr wholesale (idempotent), keeping its
// id and provenance (createdAt/createdBy). PATCH merges; PUT replaces.
function replace(id, body, actor, ifMatch) {
  const atom = getAtom(id);
  if (!visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  const modelId = refId(atom.model);
  const fields = Object.keys(body.attr || {});
  if (!fields.every((f) => allows(actor, `${modelId}.${f}`, 'update')))
    throw new Err(403, `${actor.id} cannot update ${modelId}`);
  if (ifMatch != null && Number(ifMatch) !== atom.lifecycle.version)
    throw new Err(409, `version conflict: have ${atom.lifecycle.version}, sent ${ifMatch}`);
  const before = { ...atom.attr };
  atom.attr = validate(modelId, body.attr || {});
  attenuate(actor, modelId, atom.attr);
  if (!ruleOk(actor, atom, 'write')) throw new Err(403, `write rule denies replace of ${modelId}`);
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(actor.id);
  persist(atom);
  logIt(id, 'replace', actor.id, changeset(before, atom.attr));
  return atom;
}

// Hooks (the Logic primitive). A hook is an atom { run: <script>, grants: [...] }
// registered in some atom's lifecycle.hooks (see runHooks). After a write, each
// registered hook runs its script from ./scripts/<run>.mjs and may patch the atom.
// a hook writes under ITS OWN grants — not the caller's. So a caller who can
// only submit an advocate can still trigger a hook that writes a field they can't.
function patchAtom(atom, fields, hook) {
  const modelId = refId(atom.model);
  for (const f of Object.keys(fields))
    if (!allows(hook, `${modelId}.${f}`, 'write'))
      throw new Err(403, `hook ${hook.id} is not granted write on ${modelId}.${f}`);
  const before = { ...atom.attr };
  atom.attr = { ...atom.attr, ...fields };
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(hook.id);
  persist(atom);
  logIt(atom.id, 'hook', hook.id, changeset(before, atom.attr));
}
// a hook may upsert a related atom (e.g. the census district it links to) under
// its own grants, into the subject's tenant. Returns the ref to link.
function hookUpsert(hook, subject, modelId, id, attr) {
  if (store.has(id)) return ref(id);
  for (const f of Object.keys(attr))
    if (!allows(hook, `${modelId}.${f}`, 'create'))
      throw new Err(403, `hook ${hook.id} is not granted create on ${modelId}.${f}`);
  seed({
    id, model: ref(modelId), manifest: id, attr: validate(modelId, attr),
    lifecycle: { status: 'active', version: 1, modelVersion: getAtom(modelId).attr.version || 1,
      createdAt: now(), createdBy: ref(hook.id), parent: ref(tenantOf(subject) || '0') },
  });
  if (modelId === 'model') buildInverse();
  logIt(id, 'create', hook.id, changeset({}, attr));
  return ref(id);
}
// Hooks are registered in an atom's `lifecycle.hooks` block, keyed by event
// ('create' | 'update' | 'delete'). On a write we run the hooks declared on the
// atom itself AND on its model atom — so a hook on a model fires for every
// instance, a hook on one atom fires for just that atom. Each hook is a
// capability that runs under ITS OWN grants (attenuated when it was created),
// so the caller needs no invoke permission — the hook can only do what it holds.
async function runHooks(atom, event) {
  const sources = [atom.lifecycle?.hooks];
  try { sources.push(getAtom(refId(atom.model)).lifecycle?.hooks); } catch { /* model gone */ }
  const refs = [];
  for (const hs of sources) for (const r of [].concat(hs?.[event] || [])) if (!refs.includes(r)) refs.push(r);
  for (const hr of refs) {
    const h = store.get(isRef(hr) ? refId(hr) : hr);
    if (!h || h.model !== 'atom://hook' || h.lifecycle?.status === 'retired') continue;
    try {
      const mod = await import(new URL(`./scripts/${h.attr.run}.mjs`, import.meta.url));
      await mod.default(atom, {
        patch: (f) => patchAtom(atom, f, h),
        upsert: (m, id, a) => hookUpsert(h, atom, m, id, a),
        getAtom, refId, ref,
      });
    } catch (e) { console.error(`hook ${h.id} (${h.attr.run}):`, e.message); }
  }
}

function retire(id, actor) {
  const atom = getAtom(id);
  if (!visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  if (!canOp(actor, refId(atom.model), 'delete'))
    throw new Err(403, `${actor.id} cannot delete ${refId(atom.model)}`);
  if (!ruleOk(actor, atom, 'write')) throw new Err(403, `write rule denies delete of ${refId(atom.model)}`);
  atom.lifecycle.status = 'retired';
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(actor.id);
  persist(atom);
  logIt(id, 'delete', actor.id, [{ path: 'status', from: 'active', to: 'retired' }]);
  return atom;
}

// ---------------------------------------------------------------------------
// Read path: atoms, model tables, ad-hoc queries, stored indexes
// ---------------------------------------------------------------------------

function parseQuery(search) {
  const filters = []; let sort = null, as = null;
  for (const part of search.replace(/^\?/, '').split('&').filter(Boolean)) {
    const m = part.match(/^([^<>=]+)(>=|<=|>|<|=)(.*)$/);
    if (!m) continue;
    const [, rawK, op, rawV] = m;
    const k = decodeURIComponent(rawK), v = decodeURIComponent(rawV);
    if (k === 'sort') { sort = v; continue; }
    if (k === 'as')   { as = v; continue; }
    filters.push({ field: k, op, val: v });
  }
  return { filters, sort, as };
}

// read a sortable/filterable value from attr, falling back to lifecycle (createdAt, ...)
const fieldVal = (a, key) => (a.attr && key in a.attr) ? a.attr[key] : a.lifecycle?.[key];

function passes(atom, f) {
  const v = fieldVal(atom, f.field);
  if (f.op === '=') return f.val.includes(',')
    ? f.val.split(',').includes(String(v)) : String(v) === f.val;
  const a = Number(v), b = Number(f.val);
  return f.op === '>=' ? a >= b : f.op === '<=' ? a <= b : f.op === '>' ? a > b : a < b;
}

function sortBy(atoms, sort) {
  if (!sort) return atoms;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  return [...atoms].sort((x, y) => {
    const a = fieldVal(x, key), b = fieldVal(y, key);
    const c = a < b ? -1 : a > b ? 1 : 0;
    return desc ? -c : c;
  });
}

function listModel(modelId, q, actor) {
  if (!canOp(actor, modelId, 'read')) return []; // no read grant -> no listing
  let atoms = getStore(actor).all().filter(
    (a) => a.model === ref(modelId) && a.lifecycle?.status !== 'retired' && ruleOk(actor, a, 'read'));
  for (const f of q.filters) {
    if (f.field === 'q') { // full-text over manifest + attr
      const term = f.val.toLowerCase();
      atoms = atoms.filter((a) => JSON.stringify([a.manifest, a.attr]).toLowerCase().includes(term));
    } else atoms = atoms.filter((a) => passes(a, f));
  }
  atoms = sortBy(atoms, q.sort);
  return atoms.map((a) => redact(actor, a));
}

function runIndex(indexAtom, search, actor) {
  const over = refId(indexAtom.attr.over);
  const all = over === 'atom';                 // pseudo-model atom://atom = every atom
  const params = new URLSearchParams(search);
  const match = indexAtom.attr.match || {};
  let atoms = getStore(actor).all().filter((a) =>
    a.lifecycle?.status !== 'retired' &&
    (all ? a.model !== 'atom://log' : a.model === ref(over)));
  for (const [field, cond] of Object.entries(match)) {
    if (typeof cond === 'string' && cond.startsWith('params.')) {
      const val = params.get(cond.slice('params.'.length));
      atoms = atoms.filter((a) => a.attr?.[field] === val);
    } else if (cond && typeof cond === 'object' && Array.isArray(cond.in)) {
      atoms = atoms.filter((a) => cond.in.includes(a.attr?.[field]));
    } else {
      atoms = atoms.filter((a) => a.attr?.[field] === cond);
    }
  }
  for (const s of indexAtom.attr.sort || []) {
    const [field, dir] = Object.entries(s)[0];
    atoms = sortBy(atoms, dir === 'desc' ? `-${field}` : field);
  }
  const pg = indexAtom.attr.page;             // paginate by a date cursor + limit
  if (pg) {
    const before = params.get('before');
    if (before) atoms = atoms.filter((a) => String(fieldVal(a, pg.cursor)) < before);
    atoms = atoms.slice(0, Number(params.get('limit')) || pg.limit || 25);
  }
  return atoms.map((a) => redact(actor, a));
}

// ---------------------------------------------------------------------------
// Tiny HTML rendering (UI generated from field kinds)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The atom component. Everything rendered is an atom: a value is a ref (a link
// to another atom), a scalar, a list, or an atom inside an atom (an embedded
// map) — which renders with this same component, recursively.
// link to an atom only if the actor can actually open it — it exists, isn't
// retired, is in scope, and is readable. Otherwise show the plain atom:// text.
function canSee(actor, id) {
  const a = store.get(id);
  if (!a || a.lifecycle?.status === 'retired') return false;
  return visible(actor, a) && canOp(actor, refId(a.model), 'read') && ruleOk(actor, a, 'read');
}
const link = (actor, id) => canSee(actor, id) ? `<a href="/${esc(id)}">atom://${esc(id)}</a>` : `atom://${esc(id)}`;

const atomValue = (v, actor) => {
  if (v == null) return '';
  if (isRef(v)) return link(actor, refId(v));
  if (Array.isArray(v))
    return v.every((x) => typeof x !== 'object' || isRef(x)) ? v.map((x) => atomValue(x, actor)).join(', ') : v.map((x) => atomValue(x, actor)).join('');
  if (typeof v === 'object') return renderFields(v, actor); // an atom inside an atom
  return esc(v);
};

// render an atom's fields (a map) as the key/value atom table
function renderFields(map, actor) {
  const rows = Object.entries(map).map(([k, v]) => {
    const cell = (k === 'id' && typeof v === 'string' && !isRef(v)) ? link(actor, v) : atomValue(v, actor);
    return `<tr><td>${esc(k)}</td><td>${cell}</td></tr>`;
  }).join('');
  return `<figure><table><thead><tr><th>field</th><th>value</th></tr></thead><tbody>${rows}</tbody></table></figure>`;
}

function page(title, body, fab, foot) {
  return `<!doctype html><meta charset=utf8>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css?v=${CSS.length}">
<header><h1><a href="/">Atomic</a></h1></header>
<nav>${fab || ''}</nav>
<main>${body}</main>
${foot ? `<footer>${foot}</footer>` : ''}
<script>
(function(){function num(s){return /^-?[\\d,]+(\\.\\d+)?$/.test(s)?parseFloat(s.replace(/,/g,'')):null;}
document.querySelectorAll('table').forEach(function(t){
 if(t.closest('form')||!t.tHead)return; // only data grids (with a thead) sort
 var body=t.tBodies[0]||t;
 t.tHead.querySelectorAll('th').forEach(function(th,ci){
  th.addEventListener('click',function(){
   var dir=th.getAttribute('data-dir')==='1'?-1:1;
   t.tHead.querySelectorAll('th').forEach(function(o){o.removeAttribute('data-dir');});
   th.setAttribute('data-dir',dir);
   var rows=Array.prototype.slice.call(body.rows);
   rows.sort(function(a,b){var x=((a.cells[ci]||{}).innerText||'').trim(),y=((b.cells[ci]||{}).innerText||'').trim();
    var nx=num(x),ny=num(y);var c=(nx!==null&&ny!==null)?nx-ny:x.localeCompare(y);return c*dir;});
   rows.forEach(function(r){body.appendChild(r);});});});});
})();
</script>`;
}

function renderTable(modelId, atoms, actor) {
  const m = getAtom(modelId);
  const cols = m.attr.display?.row || Object.keys(m.attr.fields || {});
  const head = ['id', ...cols].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = atoms.map((a) =>
    `<tr><td>${link(actor, a.id)}</td>` +
    cols.map((c) => `<td>${atomValue(a.attr?.[c], actor)}</td>`).join('') + '</tr>').join('');
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></figure>`;
}

// a form to create a session (sign in) — a session is itself an atom
function sessionForm() {
  const open = [...store.values()].filter((a) => a.model === 'atom://token' && a.attr.login === 'open');
  const items = open.map((t) => `<li><a href="/auth/open?token=${esc(t.id)}">demo as Advocacy Website Token</a></li>`).join('');
  return `<form method="post" action="/auth"><p><input name="email" type="email" placeholder="you@example.com" required></p><p><button>send magic link</button></p></form>
${open.length ? `<ul>${items}</ul>` : ''}`;
}

// one form generated from the model's field kinds, with a method picker built
// from the actor's grants (the auth schema). Submit runs the chosen method.
function renderForm(modelId, atom, actor) {
  const m = getAtom(modelId);
  const editing = !!atom;
  const cur = atom?.attr || {};
  const json = (name, v) => `<textarea name="${esc(name)}" data-kind="json" rows="3">${v === undefined ? '' : esc(JSON.stringify(v, null, 2))}</textarea>`;
  // recursive: scalars -> inputs, ref -> autocomplete, object/embed -> nested
  // sub-table, list with a declared item type (`of`) -> a repeater
  function control(name, def, v) {
    if (typeof def === 'string' && def.startsWith('embed://')) return embed(name, def.slice('embed://'.length), v || {});
    if (def.kind === 'enum')
      return `<select name="${esc(name)}"><option value="">—</option>${def.values.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (def.kind === 'boolean')
      return `<input type="checkbox" name="${esc(name)}"${v ? ' checked' : ''}>`;
    if (def.kind === 'ref' && def.to)
      return `<input name="${esc(name)}" data-kind="ref" list="refs-${esc(refId(def.to))}" value="${v === undefined ? '' : esc(v)}" placeholder="atom://… or embed://…">`;
    if (def.kind === 'list' && def.of) return repeater(name, def.of, Array.isArray(v) ? v : []);
    if (def.kind === 'json' || def.kind === 'map' || def.kind === 'list') return json(name, v);
    if (def.kind === 'integer' || def.kind === 'number')
      return `<input type="number" name="${esc(name)}" data-kind="number" value="${v === undefined ? '' : esc(v)}">`;
    return `<input type="text" name="${esc(name)}" data-kind="text" value="${v === undefined ? '' : esc(v)}">`;
  }
  function embed(name, subId, obj) {
    const sm = getAtom(subId);
    const rows = Object.entries(sm.attr.fields || {})
      .map(([k, def]) => `<tr><th>${esc(k)}</th><td>${control(name + '.' + k, def, obj?.[k])}</td></tr>`).join('');
    return `<figure><table>${rows}</table></figure>`;
  }
  function repeater(name, ofDef, arr) {
    const items = arr.length ? arr : [undefined];
    const blocks = items.map((it, i) => `<fieldset>${control(name + '.' + i, ofDef, it)}</fieldset>`).join('');
    return `<fieldset data-name="${esc(name)}">${blocks}<button type="button">+ add</button></fieldset>`;
  }
  const wop = editing ? 'update' : 'create';
  const fieldRows = Object.entries(m.attr.fields || {})
    .filter(([k]) => allows(actor, `${modelId}.${k}`, wop)) // only fields the actor may write
    .map(([k, def]) => `<tr><th>${esc(k)}</th><td>${control(k, def, cur[k])}</td></tr>`).join('');
  // a datalist per model — its atoms (atom://) plus embed://<model> — for any ref at any depth
  const scope = getStore(actor).all();
  const suggest = scope.filter((a) => a.model === 'atom://model').map((mm) =>
    `<datalist id="refs-${esc(mm.id)}">${scope.filter((a) => a.model === ref(mm.id) && a.lifecycle?.status !== 'retired')
      .map((a) => `<option value="atom://${esc(a.id)}">${esc(a.attr?.name || a.manifest || a.id)}</option>`).join('')}<option value="embed://${esc(mm.id)}"></option></datalist>`).join('');
  // the methods this actor may run here, from its grants (the auth schema)
  const methods = [];
  if (!editing && canOp(actor, modelId, 'create')) methods.push('POST');
  if (editing && canOp(actor, modelId, 'update')) methods.push('PATCH', 'PUT');
  if (editing && canOp(actor, modelId, 'delete')) methods.push('DELETE');
  if (!methods.length) return '';
  const LABEL = { POST: 'POST · create', PUT: 'PUT · replace', PATCH: 'PATCH · update', DELETE: 'DELETE · delete' };
  const methodRow = `<tr><th>method</th><td><select name="$method">${methods.map((x) => `<option value="${x}">${esc(LABEL[x])}</option>`).join('')}</select></td></tr>`;
  const idRows = (editing
    ? `<tr><th>id</th><td><code>${esc(atom.id)}</code></td></tr>`
    : `<tr><th>id</th><td><input name="$id" placeholder="auto"></td></tr>`)
    + `<tr><th>model</th><td><a href="/${esc(modelId)}">atom://${esc(modelId)}</a></td></tr>`;
  const manifestRow = `<tr><th>manifest</th><td><input name="$manifest" value="${editing ? esc(atom.manifest || '') : ''}" placeholder="free-text label"></td></tr>`;
  return `<form><figure><table>${methodRow}${idRows}${manifestRow}${fieldRows}</table></figure><p><button>Submit</button></p>${suggest}</form>
<script>
var F=document.querySelector('form select[name="$method"]').closest('form');
function setPath(root,path,val){var ks=path.split('.'),o=root;
 for(var i=0;i<ks.length-1;i++){var k=ks[i],nn=/^[0-9]+$/.test(ks[i+1]);if(o[k]===undefined)o[k]=nn?[]:{};o=o[k];}
 o[ks[ks.length-1]]=val;}
F.querySelectorAll('button[type="button"]').forEach(function(btn){btn.onclick=function(){
 var box=btn.parentElement,name=box.getAttribute('data-name');
 var items=box.querySelectorAll(':scope > fieldset'),last=items.length-1,c=items[last].cloneNode(true);
 c.querySelectorAll('[name]').forEach(function(el){
  el.name=el.name.split(name+'.'+last+'.').join(name+'.'+items.length+'.');
  if(el.type==='checkbox')el.checked=false;else el.value='';});
 box.insertBefore(c,btn);};});
var createUrl=${JSON.stringify('/' + modelId)}, atomUrl=${JSON.stringify(editing ? '/' + atom.id : '')};
F.onsubmit=async function(e){e.preventDefault();
var method=e.target.querySelector('[name="$method"]').value;
var url=method==='POST'?createUrl:atomUrl;
var opts={method:method,headers:{'content-type':'application/json'}};
if(method==='DELETE'){if(!confirm('Delete '+atomUrl+'?'))return;}
else{var body={},attr={},bad=null;
 e.target.querySelectorAll('[name]').forEach(function(el){var n=el.name;
  if(n==='$method')return;
  if(n==='$id'){if(el.value)body.id=el.value;return;}
  if(n==='$manifest'){body.manifest=el.value;return;}
  var val;
  if(el.type==='checkbox')val=el.checked;
  else if(el.dataset.kind==='json'){if(el.value==='')return;try{val=JSON.parse(el.value);}catch(_){bad=n;return;}}
  else{if(el.value==='')return;val=el.dataset.kind==='number'?Number(el.value):el.value;}
  setPath(attr,n,val);});
 if(bad){alert('invalid JSON in '+bad);return;}
 body.attr=attr;opts.body=JSON.stringify(body);}
var r=await fetch(url,opts);
if(r.ok){location.href=method==='DELETE'?createUrl:(method==='POST'?createUrl:atomUrl);}else{var j=await r.json();alert(j.error||'error');}};
</script>`;
}

// the top nav: a select of the models and indexes the actor can reach, by id
function navSelect(actor, current) {
  const all = getStore(actor).all();
  const opt = (a) => `<option value="/${esc(a.id)}"${a.id === current ? ' selected' : ''}>atom://${esc(a.id)}</option>`;
  const models = all.filter((a) => a.model === 'atom://model' && canTouch(actor, a.id)).map(opt).join('');
  const indexes = all.filter((a) => a.model === 'atom://index' && (canTouch(actor, a.id) || canTouch(actor, refId(a.attr.over)))).map(opt).join('');
  const sel = `<select onchange="if(this.value)location.href=this.value"><option value="/">atom://0</option>`
    + (models ? `<optgroup label="models">${models}</optgroup>` : '')
    + (indexes ? `<optgroup label="indexes">${indexes}</optgroup>` : '')
    + `</select>`;
  return sel;
}

// the signed-in footer: identity + sign out, shown on every page once authed
function footer(actor) {
  if (!actor || actor.id === '0') return '';
  return `signed in as ${atomValue(ref(actor.id), actor)} <a href="/auth/logout">sign out</a>`;
}

// Signed-in root: the workspace drawn plainly as a mind map — every model the
// actor can reach, its ref fields (the schema edges), and the atoms under it
// the actor may open. Nested <ul>s, nothing fancier.
function workspaceMap(actor) {
  const all = getStore(actor).all();
  const models = all.filter((a) => a.model === 'atom://model' && canTouch(actor, a.id));
  const branch = (m) => {
    const fields = m.attr.fields || {};
    const refs = Object.entries(fields)
      .filter(([, d]) => d && typeof d === 'object' && d.kind === 'ref')
      .map(([f, d]) => `<li>${esc(f)} → ${link(actor, refId(d.to))}</li>`).join('');
    const insts = all.filter((a) => a.id !== m.id && refId(a.model) === m.id
      && a.lifecycle?.status !== 'retired' && canSee(actor, a.id));
    const shown = insts.slice(0, 12).map((a) => `<li>${link(actor, a.id)}</li>`).join('');
    const more = insts.length > 12 ? `<li><small>… ${insts.length - 12} more</small></li>` : '';
    const kids = (refs ? `<li>refs<ul>${refs}</ul></li>` : '')
      + (insts.length ? `<li>atoms<ul>${shown}${more}</ul></li>` : '');
    return `<li>${link(actor, m.id)} <small>${esc(m.attr.label || m.id)}</small>${kids ? `<ul>${kids}</ul>` : ''}</li>`;
  };
  return `<ul>${models.map(branch).join('')}</ul>`;
}

function renderModelPage(modelId, atoms, actor) {
  const m = getAtom(modelId);
  const table = canOp(actor, modelId, 'read') ? renderTable(modelId, atoms, actor) : ''; // hidden without read
  return page(`${m.attr.label || modelId} — ${atoms.length}`,
    renderForm(modelId, null, actor) + table, navSelect(actor, modelId), footer(actor));
}

// cross-model table for indexes that span all models (over: atom://atom)
function renderCrossTable(atoms, actor) {
  const head = ['id', 'model', 'manifest', 'createdAt'].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = atoms.map((a) =>
    `<tr><td>${link(actor, a.id)}</td><td>${atomValue(a.model, actor)}</td>` +
    `<td>${esc(a.manifest || '')}</td><td>${esc(a.lifecycle?.createdAt || '')}</td></tr>`).join('');
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></figure>`;
}

function renderIndexPage(indexAtom, atoms, actor, values = {}) {
  const over = refId(indexAtom.attr.over);
  const params = indexAtom.attr.params || {};
  let form = '';
  if (Object.keys(params).length) {
    const rows = Object.entries(params).map(([name, def]) => {
      const v = values[name] || '';
      let input;
      if (def.kind === 'enum')
        input = `<select name="${esc(name)}"><option value="">—</option>${(def.values || []).map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      else if (def.kind === 'ref' && def.to)
        input = `<input name="${esc(name)}" list="refs-${esc(refId(def.to))}" value="${esc(v)}" placeholder="atom://…">`;
      else
        input = `<input name="${esc(name)}" data-kind="${esc(def.kind || 'text')}" value="${esc(v)}">`;
      return `<tr><th>${esc(name)}</th><td>${input}</td></tr>`;
    }).join('');
    const targets = [...new Set(Object.values(params).filter((d) => d.kind === 'ref' && d.to).map((d) => refId(d.to)))];
    const lists = targets.map((t) => `<datalist id="refs-${esc(t)}">${getStore(actor).all()
      .filter((a) => a.model === ref(t) && a.lifecycle?.status !== 'retired')
      .map((a) => `<option value="atom://${esc(a.id)}">${esc(a.attr?.name || a.manifest || a.id)}</option>`).join('')}</datalist>`).join('');
    form = `<form method="get" action="/${esc(indexAtom.id)}"><figure><table>${rows}</table></figure><p><button>Run</button></p>${lists}</form>`;
  }
  let body = form + (over === 'atom' ? renderCrossTable(atoms, actor) : renderTable(over, atoms, actor));
  const pg = indexAtom.attr.page;
  if (pg && atoms.length) {
    const last = atoms[atoms.length - 1];
    const cur = (last.lifecycle?.[pg.cursor]) ?? last.attr?.[pg.cursor];
    body += `<p><a href="/${indexAtom.id}?before=${encodeURIComponent(cur)}">older →</a></p>`;
  }
  return page(`${indexAtom.attr.label || indexAtom.id} — ${atoms.length}`, body, navSelect(actor, indexAtom.id), footer(actor));
}

// every place a ref to `target` appears in a value, with its dotted field path
function findRefs(v, target, prefix) {
  if (v === target) return [prefix || 'attr'];
  if (Array.isArray(v)) return v.flatMap((x) => findRefs(x, target, prefix));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, val]) => findRefs(val, target, prefix ? `${prefix}.${k}` : k));
  return [];
}
// the ref map: everything in scope that references this atom (attr or lifecycle)
function referencedBy(atom, actor) {
  const target = ref(atom.id), out = [];
  for (const a of getStore(actor).all()) {
    if (a.id === atom.id || a.lifecycle?.status === 'retired') continue;
    for (const via of findRefs(a.attr, target, '')) out.push({ id: a.id, model: refId(a.model), via, label: a.manifest || a.attr?.name || a.id });
    for (const via of findRefs(a.lifecycle, target, '')) out.push({ id: a.id, model: refId(a.model), via: `lifecycle.${via}`, label: a.manifest || a.attr?.name || a.id });
  }
  return out;
}
function renderRefMap(rows, actor) {
  if (!rows.length) return '';
  const head = ['referenced by', 'model', 'via'].map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.slice(0, 200).map((r) =>
    `<tr><td>${link(actor, r.id)}</td><td>${atomValue('atom://' + r.model, actor)}</td><td>${esc(r.via)}</td></tr>`).join('');
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></figure>`;
}

function renderAtom(atom, actor) {
  const modelId = refId(atom.model);
  // the UI mirrors the schema: render the whole atom — id, model, manifest,
  // attr, lifecycle — then the ref map (everything that references it)
  const body = renderFields(atom, actor) + renderForm(modelId, atom, actor) + renderRefMap(referencedBy(atom, actor), actor);
  return page(atom.manifest || atom.id, body, navSelect(actor, refId(atom.model)), footer(actor));
}

// ---------------------------------------------------------------------------
// HTTP surface — one address space, data or rendered view
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (!b) return resolve({});
      if (ct.includes('x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(b)));
      try { resolve(JSON.parse(b)); } catch { resolve(Object.fromEntries(new URLSearchParams(b))); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, val, html) => {
    res.writeHead(code, { 'content-type': html ? 'text/html' : 'application/json' });
    res.end(html ? val : JSON.stringify(val, null, 2));
  };
  const redirect = (location, setCookie) => {
    const h = { location }; if (setCookie) h['set-cookie'] = setCookie;
    res.writeHead(302, h); res.end();
  };
  try {
    const url = new URL(req.url, 'http://x');
    const cookies = parseCookies(req);
    const origin = `http://${req.headers.host || 'localhost'}`;
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    const wantsHtml = (req.headers.accept || '').includes('text/html') ||
                      url.searchParams.get('as') === 'html';

    if (req.method === 'GET' && path === 'style.css') {
      res.writeHead(200, { 'content-type': 'text/css' }); return res.end(CSS);
    }

    // --- sign-in: magic link -> tracked session cookie ---
    if (req.method === 'POST' && path === 'auth') {
      const { email } = await readBody(req);
      const tok = [...store.values()].find((a) => a.model === 'atom://token' && a.attr.email === email);
      if (!tok) return send(404, { error: 'no token for that email' });
      const code = randomUUID();
      magic.set(code, { token: tok.id, exp: Date.now() + 15 * 60000 });
      const link = `${origin}/auth/verify?code=${code}`;
      const sent = await sendMagicLink(email, link);
      if (wantsHtml) return send(200, page('Check your email', sent
        ? `<p>A sign-in link was emailed to <code>${esc(email)}</code>. It expires in 15 minutes.</p>`
        : `<p>Email is not configured — use this link:</p><p><a href="${link}">${esc(link)}</a></p>`), true);
      return send(200, sent ? { sent: true } : { link });
    }
    if (req.method === 'GET' && path === 'auth/verify') {
      const code = url.searchParams.get('code');
      const rec = code && magic.get(code);
      if (!rec || rec.exp < Date.now()) return send(401, { error: 'invalid or expired link' });
      magic.delete(code);
      const sid = newSession(rec.token);
      return redirect('/', `atomic_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    }
    if (req.method === 'GET' && path === 'auth/open') {
      const id = url.searchParams.get('token');
      const t = id && store.get(id);
      if (!t || t.model !== 'atom://token' || t.attr.login !== 'open') return send(403, { error: 'not an open-login token' });
      return redirect('/', `atomic_session=${newSession(t.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    }
    if (req.method === 'GET' && path === 'auth/logout') {
      const sid = cookies['atomic_session'];
      if (sid && store.has(sid)) store.get(sid).lifecycle.status = 'retired';
      return redirect('/', 'atomic_session=; Path=/; Max-Age=0');
    }

    const actor = actorFromReq(req, cookies);
    const isAnon = actor.id === '0';
    const [head, ...segs] = path.split('.');

    // the root is atom://0 — render it like any atom; anon also gets a create-session form
    if (req.method === 'GET' && path === '') {
      const a = getAtom('0');
      if (!wantsHtml) return send(200, a);
      let body = renderFields(a, actor);
      body += isAnon ? sessionForm() : workspaceMap(actor);
      return send(200, page(a.manifest || 'atom://0', body, navSelect(actor, ''), footer(actor)), true);
    }
    // no anonymous access beyond the root
    if (isAnon) {
      if (wantsHtml) return redirect('/');
      return send(401, { error: 'authenticate: POST /auth { email } or Authorization: Bearer <token>' });
    }

    if (req.method === 'GET') {
      // atom://atom is the universal type — every atom, newest first
      if (head === 'atom' && segs.length === 0) {
        const atoms = sortBy(getStore(actor).all().filter((a) => a.lifecycle?.status !== 'retired'), '-createdAt')
          .map((a) => redact(actor, a));
        if (wantsHtml) return send(200, page('atom — every atom', renderCrossTable(atoms, actor), navSelect(actor, ''), footer(actor)), true);
        return send(200, atoms);
      }
      const headAtom = getAtom(head);
      const q = parseQuery(url.search);
      let result;
      if (headAtom.model === 'atom://index') {
        const atoms = runIndex(headAtom, url.search, actor);
        if (wantsHtml) return send(200, renderIndexPage(headAtom, atoms, actor, Object.fromEntries(url.searchParams)), true);
        result = atoms;
      } else if (headAtom.model === 'atom://model' && segs.length === 0) {
        const atoms = listModel(head, q, actor);
        if (wantsHtml) return send(200, renderModelPage(head, atoms, actor), true);
        result = atoms;
      } else if (segs.length) result = traverse(headAtom, segs);
      else {
        if (!visible(actor, headAtom) || !canOp(actor, refId(headAtom.model), 'read') || !ruleOk(actor, headAtom, 'read'))
          throw new Err(404, `no atom ${head}`);
        const a = redact(actor, headAtom);
        if (wantsHtml) return send(200, renderAtom(a, actor), true);
        result = a;
      }
      return send(200, result);
    }

    if (req.method === 'POST') { const a = create(head, await readBody(req), actor); await runHooks(a, 'create'); return send(201, a); }
    if (req.method === 'PUT') { const a = replace(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); return send(200, a); }
    if (req.method === 'PATCH') { const a = update(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); return send(200, a); }
    if (req.method === 'DELETE') { const a = retire(head, actor); await runHooks(a, 'delete'); return send(200, a); }
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    send(e.code || 500, { error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap — joey seeds atom://0 and the core models; then a CRM tenant
// ---------------------------------------------------------------------------

function bootstrap() {
  const lc = (by, parent = '0') => ({ status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(by), parent: ref(parent) });
  const model = (id, label, fields, extra = {}) => seed({
    id, model: 'atom://model', manifest: label,
    attr: { label, version: 1, fields, ...extra }, lifecycle: lc('0'),
  });

  // genesis: joey -> atom://0 -> core models
  // joey is the root authority; atom://0 is the public/anonymous identity that
  // also describes the app (no data grants — it is what an unauthenticated caller sees).
  seed({ id: 'joey', model: 'atom://token', manifest: 'Joey — admin',
    attr: { email: 'joey@emailjoey.com', grants: [{ path: '**', mode: 'all' }] }, lifecycle: lc('joey') });
  seed({ id: '0', model: 'atom://token', manifest: 'Atomic (public root + anonymous identity)',
    attr: { name: 'Atomic',
      description: 'A data substrate where schema, data, identity, and the UI surface are all atoms.',
      grants: [] }, lifecycle: lc('joey') });

  // core model definitions (the kernel's own types are model atoms)
  model('model',  'Model',  { label: { kind: 'text' }, fields: { kind: 'map', required: true },
    indexes: { kind: 'map' }, rules: { kind: 'json' }, display: { kind: 'json' }, behavior: { kind: 'json' } });
  model('token',  'Token',  { email: { kind: 'email' }, login: { kind: 'enum', values: ['open'] },
    grants: { kind: 'list', of: 'embed://grant' }, roles: { kind: 'list' } });
  model('grant',  'Grant',  { path: { kind: 'text', required: true },
    mode: { kind: 'enum', values: ['read', 'create', 'update', 'delete', 'write', 'all'] } });
  model('role',   'Role',   { label: { kind: 'text' }, grants: { kind: 'list', of: 'embed://grant' } });
  model('tenant', 'Tenant', { name: { kind: 'text', required: true } });
  model('index',  'Index',  { label: { kind: 'text' }, over: { kind: 'ref', to: 'atom://model' },
    params: { kind: 'map' }, match: { kind: 'json' }, sort: { kind: 'list' }, returns: { kind: 'text' } });
  model('log',    'Log',    { atom: { kind: 'ref', to: 'atom://atom' }, op: { kind: 'text' },
    actor: { kind: 'ref', to: 'atom://token' }, at: { kind: 'datetime' }, changes: { kind: 'list' } });
  model('session','Session',{ token: { kind: 'ref', to: 'atom://token' },
    createdAt: { kind: 'datetime' }, expiresAt: { kind: 'datetime' } });
  model('hook',   'Hook',   { label: { kind: 'text' }, run: { kind: 'text', required: true },
    grants: { kind: 'list', of: 'embed://grant' } });

  // core indexes (queries are atoms too)
  seed({ id: 'atomLog', model: 'atom://index', manifest: 'Full change history for one atom',
    attr: { label: 'Atom log', over: 'atom://log', params: { atom: { kind: 'ref', to: 'atom://atom' } },
      match: { atom: 'params.atom' }, sort: [{ at: 'asc' }], returns: 'set' }, lifecycle: lc('0') });
  seed({ id: 'recent', model: 'atom://index', manifest: 'Recent atoms across all models',
    attr: { label: 'Recent', over: 'atom://atom', sort: [{ createdAt: 'desc' }],
      page: { cursor: 'createdAt', limit: 25 }, returns: 'page' }, lifecycle: lc('0') });
  // Demo tenants A / B / C are loaded from seed-a.mjs / seed-b.mjs / seed-c.mjs
  // (POSTed through the API as the admin) so they never bloat the kernel.

  buildInverse();

  // genesis ledger: every seeded atom is itself a logged change — everything is logged
  for (const a of [...store.values()]) {
    if (a.model === 'atom://log') continue;
    const by = typeof a.lifecycle === 'object' ? refId(a.lifecycle.createdBy) : '0';
    logIt(a.id, 'genesis', by, changeset({}, a.attr));
  }
}

if (loadAll()) {                 // durable store on disk -> replay it
  buildInverse();
  logSeq = [...store.values()].reduce((m, a) => a.id.startsWith('log-') ? Math.max(m, +a.id.slice(4) || 0) : m, 0);
} else {
  bootstrap();                   // fresh -> seed (and persist, if ATOMIC_STORE is set)
}
const PORT = process.env.PORT || 7777;
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${store.size} atoms${ROOT ? `, persisted -> ${ROOT}` : ', in-memory'})`);
});

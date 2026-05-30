// Atomic — the most minimal kernel.
//
// One store of atoms. The schema is atoms. Identity is a token atom.
// CRUD is the ledger. The HTTP surface is generated from the atoms.
//
// Dependency-free. Run: node kernel.mjs   (Node >= 18)
//
// In-memory by default; point ATOMIC_STORE at a directory for durable,
// per-tenant, append-only persistence — replayed on boot, optionally AES-256-GCM
// encrypted at rest. It implements the load-bearing model from the README; a few
// deeper paths remain marked TODO (migration-on-read, rule-predicate breadth).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

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

const readAsset = (name) => { try { return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'); } catch { return ''; } };
const CSS = readAsset('style.css');
const APP = readAsset('app.js'); // the static client, served same-origin so the page runs under a strict CSP
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

// storeGen is bumped on every store mutation. Read-side memos (tenantOf,
// grantsOf, getStore's scan) tag their cached value with the gen they were
// computed at and recompute when it moves — so a request never rescans the
// whole store more than once, but a write is instantly visible to the next read.
let storeGen = 0;

// Put an atom straight into the store (bootstrap / seed — bypasses checks).
// Every write funnels a log atom through seed(), so bumping here invalidates
// the read memos after any mutation, not just direct seeds.
function seed(atom) { store.set(atom.id, atom); storeGen++; persist(atom); return atom; }

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
    // virtual `.tenant` edge: every atom's nearest tenant ancestor, as a ref (or
    // null at the global root). Lets rules read `actor.tenant` / `atom.tenant`
    // without a stored field. Only a fallback — a real `tenant` attr wins above.
    if (seg === 'tenant') { const t = tenantOf(node); return t ? ref(t) : null; }
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
    case 'map': if (typeof val !== 'object' || val === null || Array.isArray(val)) fail('an object'); break;
    case 'json': break; // any JSON value — scalar, array, or object
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
  // a bearer credential must resolve to a TOKEN atom — never any other atom kind,
  // so e.g. `Bearer northwind` (a company id) can't be presented as an identity.
  if (m && store.has(m[1])) { const t = getAtom(m[1]); if (t.model === 'atom://token') return t; }
  const sid = cookies['atomic_session'];                 // browsers carry a session the kernel tracks
  if (sid && store.has(sid)) {
    const s = store.get(sid);
    if (s.model === 'atom://session' && s.lifecycle.status === 'active' &&
        (!s.attr.expiresAt || s.attr.expiresAt > now()) && store.has(refId(s.attr.token))) {
      const t = getAtom(refId(s.attr.token));
      // the session must still bind a live token (it could have been retired)
      if (t.model === 'atom://token' && t.lifecycle?.status !== 'retired')
        return { ...t, _session: sid };  // a transient copy carrying the session id — never mutate the stored atom
    }
  }
  return getAtom('0'); // atom://0 — the anonymous identity (no data grants)
}

// A session is an atom too — it binds a cookie id to the token it authenticates.
function newSession(tokenId) {
  const id = `sess-${randomUUID()}`; // full 122-bit id — this cookie is a bearer credential
  // a session is parented into the token's own tenant, not left global. Combined
  // with the surface never serving session atoms (see getStore + the GET guard),
  // this means one tenant can never read another's live session ids (cookies).
  const parent = tenantOf(store.get(tokenId)) || '0';
  seed({
    id, model: 'atom://session', manifest: `session for ${tokenId}`,
    attr: { token: ref(tokenId), createdAt: now(), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(tokenId), parent: ref(parent) },
  });
  return id;
}

// a token's effective grants = its own grants + the grants of every role it
// references. A role atom is just a reusable bundle of grants (see canSee/role).
const _grants = new WeakMap(); // actor obj -> { gen, val }; actor objs are per-request
const grantsOf = (actor) => {
  const hit = _grants.get(actor);
  if (hit && hit.gen === storeGen) return hit.val;
  const val = [
    ...(actor.attr?.grants || []),
    ...(actor.attr?.roles || []).flatMap((r) => store.get(isRef(r) ? refId(r) : r)?.attr?.grants || []),
  ];
  _grants.set(actor, { gen: storeGen, val });
  return val;
};

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
// May the actor see this atom AT ALL (vs. just some of its attributes)? Used to
// gate the universal feed and index results so they never leak the id/manifest of
// an atom the actor holds no read grant for. Per-attribute redaction happens after.
const readableAtom = (actor, a) =>
  a.lifecycle?.status !== 'retired' && canOp(actor, refId(a.model), 'read') && ruleOk(actor, a, 'read');

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

// May `actor` WRITE `atom`? Per the tree model (README: "you can write an atom
// only if it shares your tenant ancestor; a token with no tenant is a superuser"):
// a tenant user may write only atoms in its OWN tenant — never a global/root atom
// (the core substrate + shared definitions, which have no tenant ancestor) and
// never another tenant's. A tenant-less root writes anything. The model's own
// write rule is then ANDed on top. This makes "root atoms are root-only" a
// structural invariant for EVERY type, not a per-model rule.
const writable = (actor, atom) =>
  (tenantOf(actor) === null || tenantOf(atom) === tenantOf(actor)) && ruleOk(actor, atom, 'write');

// the tenant is the parent atom: an atom's tenant is its nearest tenant ancestor
// (walk lifecycle.parent). Global atoms (the core models) have none.
const _tenant = new Map(); // id -> { gen, val }; the ancestor walk is pure given the store
function tenantOf(atom) {
  if (!atom) return null;
  const hit = _tenant.get(atom.id);
  if (hit && hit.gen === storeGen) return hit.val;
  let cur = atom, val = null;
  for (let hops = 0; cur && hops < 8; hops++) {
    if (cur.model === 'atom://tenant') { val = cur.id; break; }
    const p = cur.lifecycle?.parent;
    if (!isRef(p) || refId(p) === cur.id) break;
    cur = store.get(refId(p));
  }
  _tenant.set(atom.id, { gen: storeGen, val });
  return val;
}
// a global atom is visible to all; otherwise the actor must share its tenant
function visible(actor, atom) {
  if (isExpired(atom)) return false;          // lazy expiry: past its policy → invisible
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
const _scope = new WeakMap(); // actor obj -> { gen, list }
function getStore(actor) {
  let hit = _scope.get(actor);
  if (!hit || hit.gen !== storeGen) {
    // session atoms are bearer credentials, never application data: they are
    // excluded from every actor-facing read here, so no listing, index, feed,
    // ref-map, datalist, or workspace can ever surface a live cookie id.
    hit = { gen: storeGen, list: [...store.values()].filter((a) => a.model !== 'atom://session' && visible(actor, a)) };
    _scope.set(actor, hit);
  }
  return { all: () => hit.list };
}

// ---------------------------------------------------------------------------
// Durability. Each tenant is a shard on disk: an append-only NDJSON log under
// ATOMIC_STORE/<tenant>/log.ndjson. State is the fold of the log, replayed on
// boot. Per-tenant files give physical isolation (a node serves one tenant's
// file); unset ATOMIC_STORE keeps the kernel purely in-memory (the default).
// ---------------------------------------------------------------------------
const ROOT = process.env.ATOMIC_STORE || null;
const _dirs = new Set(); // shard dirs we've already mkdir'd this process — skip the syscall
const shardOf = (atom) => tenantOf(atom) || '_global';

// Encryption at rest (opt-in). Set ATOMIC_KEY to a 64-char hex key or any
// passphrase (stretched with scrypt). When set, each shard-log line is written
// as `enc:<base64(iv12 ‖ tag16 ‖ ciphertext)>` under AES-256-GCM — confidential
// and tamper-evident (GCM auth tag). Unset → plaintext NDJSON (the default).
// Reads accept either form per line, so turning the key on is forward-only and a
// store written without it still loads.
const KEY = process.env.ATOMIC_KEY
  ? (/^[0-9a-f]{64}$/i.test(process.env.ATOMIC_KEY)
      ? Buffer.from(process.env.ATOMIC_KEY, 'hex')
      : scryptSync(process.env.ATOMIC_KEY, 'atomic-shard-v1', 32))
  : null;
function serializeLine(atom) {
  if (!KEY) return JSON.stringify(atom);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(atom), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function parseLine(line) {
  if (!line.startsWith('enc:')) return JSON.parse(line);
  if (!KEY) throw new Err(500, 'shard is encrypted but ATOMIC_KEY is not set');
  const buf = Buffer.from(line.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
function persist(atom) {
  if (!ROOT) return;
  const dir = path.join(ROOT, shardOf(atom));
  if (!_dirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); _dirs.add(dir); }
  fs.appendFileSync(path.join(dir, 'log.ndjson'), serializeLine(atom) + '\n');
}
function loadAll() {
  if (!ROOT || !fs.existsSync(ROOT)) return false;
  let n = 0;
  for (const shard of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, shard, 'log.ndjson');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n'))
      if (line.trim()) { const a = parseLine(line); store.set(a.id, a); n++; }
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

function logIt(atomId, op, actorId, changes, sessionId) {
  const id = `log-${++logSeq}`;
  const subj = store.get(atomId);
  seed({
    id, model: 'atom://log', manifest: `${op} ${atomId}`,
    attr: { atom: ref(atomId), op, actor: ref(actorId),
      ...(sessionId ? { session: ref(sessionId) } : {}), at: now(), changes },
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

// Commit an in-place mutation: stamp the new version + provenance and persist.
// Every mutator (merge / update / replace / retire / hook patch) ends here, so
// "what it means to durably change an atom" lives in exactly one place.
function bump(atom, by) {
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(by);
  persist(atom);
}

// a writer may point an atom's lifecycle.expiration at any policy they can see
// (their own tenant's, or a global one); absent → the supplied fallback. This is
// how a user automates retention of their own data without operator help.
function resolveExpiration(body, actor, fallback) {
  if (body.expiration === undefined) return fallback;
  if (!isRef(body.expiration)) throw new Err(400, 'expiration must be a policy reference');
  const pol = getAtom(refId(body.expiration));
  if (pol.model !== 'atom://policy') throw new Err(400, `${body.expiration} is not a policy`);
  if (!visible(actor, pol)) throw new Err(403, `cannot use policy ${body.expiration}`);
  return body.expiration;
}

function create(modelId, body, actor) {
  const modelAtom = getAtom(modelId);
  const fields = Object.keys(body.attr || {});
  // a baseline create grant on the model is required even for an all-default/empty
  // body — otherwise `fields.every(...)` is vacuously true and a grantless actor
  // could create atoms of any all-optional model. Then each named field is checked.
  if (!canOp(actor, modelId, 'create') || !fields.every((f) => allows(actor, `${modelId}.${f}`, 'create')))
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
    bump(existing, actor.id);
    logIt(existing.id, 'merge', actor.id, changeset(before, existing.attr), actor._session);
    return existing;
  }

  // by default an atom is born into the creator's tenant; an authorized caller
  // may place it under a chosen parent (e.g. root provisioning a new tenant)
  let parentId = tenantOf(actor) || '0';
  if (body.parent && isRef(body.parent)) {
    const target = getAtom(refId(body.parent));
    // a non-superuser may only place an atom within its OWN tenant — not into
    // another tenant, and not into the global scope (parent atom://0, which is
    // world-visible). Only a tenant-less superuser (root) provisions across or
    // above tenants. (visible() allows global, so check tenant equality here.)
    if (tenantOf(actor) !== null && tenantOf(target) !== tenantOf(actor))
      throw new Err(403, `${actor.id} cannot place into ${body.parent}`);
    parentId = refId(body.parent);
  }
  // a generated id must be unique — never silently clobber an existing atom.
  // (An explicit body.id collision is already a 409 above.)
  let id = body.id;
  if (!id) do { id = randomUUID().slice(0, 8); } while (store.has(id));
  const atom = {
    id, model: ref(modelId),
    manifest: body.manifest || '',
    attr,
    lifecycle: {
      status: 'active', version: 1,
      modelVersion: modelAtom.attr.version || 1,
      createdAt: now(), updatedAt: now(), createdBy: ref(actor.id), parent: ref(parentId),
      expiration: resolveExpiration(body, actor, ref('policy-default')), // a chosen policy, else the default
      ...(body.hooks ? { hooks: body.hooks } : {}), // hooks registered on this atom
    },
  };
  if (!writable(actor, atom))
    throw new Err(403, `cannot create ${modelId} (tenant scope or write rule)`);
  seed(atom);
  if (modelId === 'model') {
    buildInverse(); // a new model may declare inverse edges
    // creator-owns: defining a type mints full ownership of it for a tenant user,
    // so they can immediately CRUD its instances. Attenuation can't self-grant a
    // brand-new type, and creating it IS the legitimate mint — the type is empty,
    // so this grants nothing over pre-existing data. Root already holds **.
    if (tenantOf(actor) !== null) {
      const tok = store.get(actor.id);
      if (tok?.model === 'atom://token') {
        const grants = tok.attr.grants || (tok.attr.grants = []);
        if (!grants.some((x) => x.path === `${id}.*`)) { grants.push({ path: `${id}.*`, mode: 'all' }); bump(tok, actor.id); }
      }
    }
  }
  logIt(id, 'create', actor.id, changeset({}, attr), actor._session);
  return atom;
}

// PATCH merges body.attr into the current attr; PUT replaces it wholesale. Both
// keep the atom's id and provenance (createdAt/createdBy), bump the version, and
// append to the ledger — the only differences are the next-attr expression and
// the log op label, so they share one body.
function writeAtom(id, body, actor, ifMatch, mode) {
  const atom = getAtom(id);
  if (!visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  const modelId = refId(atom.model);
  const fields = Object.keys(body.attr || {});
  if (!fields.every((f) => allows(actor, `${modelId}.${f}`, 'update')))
    throw new Err(403, `${actor.id} cannot update ${modelId}`);
  if (ifMatch != null && Number(ifMatch) !== atom.lifecycle.version)
    throw new Err(409, `version conflict: have ${atom.lifecycle.version}, sent ${ifMatch}`);
  const before = { ...atom.attr };
  atom.attr = validate(modelId, mode === 'replace' ? (body.attr || {}) : { ...atom.attr, ...body.attr });
  attenuate(actor, modelId, atom.attr);
  if (!writable(actor, atom)) throw new Err(403, `cannot ${mode} ${modelId} (tenant scope or write rule)`);
  if (mode === 'update' && body.hooks) atom.lifecycle.hooks = body.hooks; // (re)register lifecycle hooks
  if (body.expiration !== undefined) atom.lifecycle.expiration = resolveExpiration(body, actor, atom.lifecycle.expiration); // re-point retention policy
  bump(atom, actor.id);
  logIt(id, mode, actor.id, changeset(before, atom.attr), actor._session);
  return atom;
}
const update  = (id, body, actor, ifMatch) => writeAtom(id, body, actor, ifMatch, 'update');
const replace = (id, body, actor, ifMatch) => writeAtom(id, body, actor, ifMatch, 'replace');

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
  bump(atom, hook.id);
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
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(h.attr.run || ''))) { // never import a path-traversing run
      console.error(`hook ${h.id}: unsafe run "${h.attr.run}" — skipped`); continue;
    }
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
  if (!writable(actor, atom)) throw new Err(403, `cannot delete ${refId(atom.model)} (tenant scope or write rule)`);
  atom.lifecycle.status = 'retired';
  bump(atom, actor.id);
  logIt(id, 'delete', actor.id, [{ path: 'status', from: 'active', to: 'retired' }], actor._session);
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

// read a sortable/filterable value from attr, falling back to lifecycle
// (createdAt, ...) then the atom's own top-level fields (model, manifest, id)
const fieldVal = (a, key) =>
  (a.attr && key in a.attr) ? a.attr[key]
  : (a.lifecycle && key in a.lifecycle) ? a.lifecycle[key]
  : a[key];

// ---------------------------------------------------------------------------
// Expiration (lazy, non-destructive). Every atom's lifecycle.expiration is a ref
// to a policy atom; a policy is a set of condition atoms. An atom is expired when
// ALL of its policy's conditions hold (a policy with no conditions never expires).
// A condition is itself an atom { field, op, value } — the default policy carries
// one: older(updatedAt, 3y), i.e. not touched in three years. Expired atoms are
// just filtered out of every read by visible() — nothing is mutated, so editing
// the atom (which bumps updatedAt) or its policy brings it straight back.
// ---------------------------------------------------------------------------
function parseDuration(s) {
  const m = /^(\d+)\s*(y|mo|w|d)$/.exec(String(s || '').trim());
  if (!m) return null;
  const n = +m[1];
  const days = m[2] === 'y' ? 365 * n : m[2] === 'mo' ? 30 * n : m[2] === 'w' ? 7 * n : n;
  return days * 864e5;
}
// does a single condition atom hold for this atom?
function evalCondition(atom, cond) {
  if (!cond?.attr) return false;
  const { field, op, value } = cond.attr;
  const v = fieldVal(atom, field);
  switch (op) {
    case 'eq': return v === value;
    case 'ne': return v !== value;
    case 'in': return Array.isArray(value) && value.includes(v);
    case 'older': case 'newer': {           // date `field` vs a duration before now
      const ms = parseDuration(value);
      const base = v || atom.lifecycle?.createdAt;
      if (ms == null || !base) return false;
      const elapsed = Date.parse(base) + ms < Date.now();
      return op === 'older' ? elapsed : !elapsed;
    }
    default: return false;
  }
}
function isExpired(atom) {
  const exp = atom?.lifecycle?.expiration;
  if (!exp) return false;
  const pol = store.get(isRef(exp) ? refId(exp) : exp);
  const conds = pol?.attr?.conditions;
  if (!Array.isArray(conds) || !conds.length) return false;   // no conditions → never
  return conds.every((c) => evalCondition(atom, store.get(isRef(c) ? refId(c) : c)));
}

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
    readableAtom(actor, a) &&
    (all ? a.model !== 'atom://log' : a.model === ref(over)));
  for (const [field, cond] of Object.entries(match)) {
    if (typeof cond === 'string' && cond.startsWith('params.')) {
      const val = params.get(cond.slice('params.'.length));
      atoms = atoms.filter((a) => fieldVal(a, field) === val);
    } else if (cond && typeof cond === 'object' && Array.isArray(cond.in)) {
      atoms = atoms.filter((a) => cond.in.includes(fieldVal(a, field)));
    } else {
      atoms = atoms.filter((a) => fieldVal(a, field) === cond);
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
// HTML rendering — the UI generated from field kinds
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
<header><h1><a href="/">Atomic</a></h1>${foot ? `<p>${foot}</p>` : ''}</header>
<nav>${fab || ''}</nav>
<main>${body}</main>
<script src="/app.js?v=${APP.length}" defer></script>`;
}

// ---------------------------------------------------------------------------
// CSV — a flat view of a model's atoms, for export and an import template. The
// columns are id, manifest, then every field. ref cells are atom:// strings;
// embed/list/map/json cells are JSON, so a round-trip (export → edit → import)
// preserves shape. Import is plain CRUD: each row is POSTed to the model.
// ---------------------------------------------------------------------------
const csvCell = (v) => {
  if (v == null) return '';
  const s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');
const modelCols = (modelAtom) => Object.keys(modelAtom.attr.fields || {});
// header-only template: the shape to fill in for import
const templateCsv = (modelAtom) => csvRow(['id', 'manifest', ...modelCols(modelAtom)]) + '\n';
// the field-kind map an importer uses to coerce each cell (embed → a json object)
function fieldKinds(modelAtom) {
  const out = {};
  for (const [k, def] of Object.entries(modelAtom.attr.fields || {}))
    out[k] = (typeof def === 'string' && def.startsWith('embed://')) ? 'json' : (def.kind || 'text');
  return out;
}
// export a set of atoms. modelId null → cross-model (an index over atom://atom).
function atomsCsv(modelId, atoms) {
  if (!modelId) {
    const lines = [csvRow(['id', 'model', 'manifest', 'createdAt'])];
    for (const a of atoms) lines.push(csvRow([a.id, refId(a.model), a.manifest || '', a.lifecycle?.createdAt || '']));
    return lines.join('\n') + '\n';
  }
  const cols = modelCols(getAtom(modelId));
  const lines = [csvRow(['id', 'manifest', ...cols])];
  for (const a of atoms) lines.push(csvRow([a.id, a.manifest || '', ...cols.map((c) => a.attr?.[c])]));
  return lines.join('\n') + '\n';
}

// ---- Import (the inverse of export). A POST to a model with a CSV or a JSON
// array body is a bulk create: each row/element runs through the normal create()
// path — same grants, attenuation, rules, dedup, and hooks — and the response is
// a per-row summary. "Import" is not a new verb; it is POST over many records.
function parseCsvText(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function coerceCsv(kind, raw) {
  if (raw === '') return undefined;
  if (kind === 'number' || kind === 'integer') { const n = Number(raw); return isNaN(n) ? raw : n; }
  if (kind === 'boolean') return /^(true|1|yes)$/i.test(raw);
  if (kind === 'json' || kind === 'map' || kind === 'list') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw; // text/email/url/uuid/ref/datetime/enum pass through as-is
}
// a CSV (id, manifest, then fields) → create bodies, coercing each cell by kind
function csvToBodies(modelId, text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const kinds = fieldKinds(getAtom(modelId));
  const bodies = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.length || cells.every((c) => c === '')) continue;
    const body = { attr: {} };
    header.forEach((h, ci) => {
      const v = cells[ci]; if (v === undefined || v === '') return;
      if (h === 'id') body.id = v;
      else if (h === 'manifest') body.manifest = v;
      else { const cv = coerceCsv(kinds[h] || 'text', v); if (cv !== undefined) body.attr[h] = cv; }
    });
    bodies.push(body);
  }
  return bodies;
}
async function bulkCreate(modelId, bodies, actor) {
  const out = { imported: 0, failed: [] };
  for (let i = 0; i < bodies.length; i++) {
    try { const a = create(modelId, bodies[i], actor); await runHooks(a, 'create'); out.imported++; }
    catch (e) { out.failed.push({ row: i, id: bodies[i]?.id || null, error: e.message }); }
  }
  return out;
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
  const items = open.map((t) => `<li><a href="/auth/open?token=${esc(t.id)}">atom://${esc(t.id)}</a></li>`).join('');
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
  // a mutating method shows only when BOTH the grant (canOp) and the per-atom
  // write rule allow it — so e.g. Billy sees an edit form on his OWN index but
  // not on a shared/global one his grant covers yet the rule forbids.
  const mayWrite = !editing || writable(actor, atom);
  if (!editing && canOp(actor, modelId, 'create')) methods.push('POST', 'IMPORT');
  if (editing && mayWrite && canOp(actor, modelId, 'update')) methods.push('PATCH', 'PUT');
  if (editing && mayWrite && canOp(actor, modelId, 'delete')) methods.push('DELETE');
  if (!methods.length) return '';
  const LABEL = { POST: 'POST · create', IMPORT: 'IMPORT · bulk CSV', PUT: 'PUT · replace', PATCH: 'PATCH · update', DELETE: 'DELETE · delete' };
  // IMPORT mode (revealed by app.js when chosen): a template to fill + a dropzone
  // that POSTs the CSV to this model. The server bulk-creates it under the same
  // grants/rules as a single create. Only in create context (!editing).
  const importRow = (!editing && canOp(actor, modelId, 'create'))
    ? `<tr data-import-row hidden><th>csv</th><td><p><a href="/${esc(modelId)}?as=template" download>download template</a></p>`
      + `<figure data-import="/${esc(modelId)}"><p>Drop a CSV here to import, or <input type="file" accept=".csv,text/csv"></p></figure></td></tr>`
    : '';
  const methodRow = `<tr><th>method</th><td><select name="$method">${methods.map((x) => `<option value="${x}">${esc(LABEL[x])}</option>`).join('')}</select></td></tr>`;
  const idRows = (editing
    ? `<tr><th>id</th><td><code>${esc(atom.id)}</code></td></tr>`
    : `<tr><th>id</th><td><input name="$id" placeholder="auto"></td></tr>`)
    + `<tr><th>model</th><td><a href="/${esc(modelId)}">atom://${esc(modelId)}</a></td></tr>`;
  const manifestRow = `<tr><th>manifest</th><td><input name="$manifest" value="${editing ? esc(atom.manifest || '') : ''}" placeholder="free-text label"></td></tr>`;
  // the form is data-driven; /app.js reads these targets and wires submit + repeaters
  return `<form data-create="${esc('/' + modelId)}" data-atom="${editing ? esc('/' + atom.id) : ''}"><figure><table>${methodRow}${idRows}${manifestRow}${fieldRows}${importRow}</table></figure><p><button>Submit</button></p>${suggest}</form>`;
}

// the top nav: indexes the actor can reach, then every model it can touch below.
function navSelect(actor, current) {
  const all = getStore(actor).all().filter((a) => a.lifecycle?.status !== 'retired');
  const opt = (a) => `<option value="/${esc(a.id)}"${a.id === current ? ' selected' : ''}>atom://${esc(a.id)}</option>`;
  const indexes = all.filter((a) => a.model === 'atom://index' && (canTouch(actor, a.id) || canTouch(actor, refId(a.attr.over)))).map(opt).join('');
  const models = all.filter((a) => a.model === 'atom://model' && canTouch(actor, a.id)).map(opt).join('');
  return `<select data-nav><option value="/">atom://0</option>`
    + (indexes ? `<optgroup label="indexes">${indexes}</optgroup>` : '')
    + (models ? `<optgroup label="models">${models}</optgroup>` : '')
    + `</select>`;
}

// the signed-in identity line (shown under the logo): who + sign out
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

function renderModelPage(modelId, atoms, actor, search = '') {
  const m = getAtom(modelId);
  const canRd = canOp(actor, modelId, 'read');
  const table = canRd ? renderTable(modelId, atoms, actor) : ''; // hidden without read
  const qs = (search || '').replace(/^\?/, '');
  const exp = canRd ? `<a href="/${esc(modelId)}?${qs ? qs + '&' : ''}as=csv" download>export CSV</a>` : '';
  return page(`${m.attr.label || modelId} — ${atoms.length}`,
    renderForm(modelId, null, actor) + table, navSelect(actor, modelId) + exp, footer(actor));
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
  // the index's own create/edit form — POST a new report on the model page, or
  // PATCH/PUT/DELETE one you own here (renderForm gates by grant + the write rule)
  body += renderForm('index', indexAtom, actor);
  const ps = new URLSearchParams(values); ps.delete('as'); ps.set('as', 'csv');
  const exp = `<a href="/${esc(indexAtom.id)}?${esc(ps.toString())}" download>export CSV</a>`;
  return page(`${indexAtom.attr.label || indexAtom.id} — ${atoms.length}`, body, navSelect(actor, indexAtom.id) + exp, footer(actor));
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
    if (!canSee(actor, a.id)) continue;   // only backlinks the actor may actually read
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
  // https when the request arrived over TLS directly or via a proxy (nginx sets
  // x-forwarded-proto). Drives the Secure cookie flag and the magic-link origin.
  const tls = req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  // Defense-in-depth headers on every response. The CSP locks scripts to our own
  // same-origin /app.js (there is no inline script anywhere), styles to our sheet
  // plus Google Fonts, and connect/img/form-action to same-origin only.
  const SECURITY = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
    + "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
    + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const send = (code, val, html) => {
    res.writeHead(code, { 'content-type': html ? 'text/html' : 'application/json',
      ...SECURITY, ...(html ? { 'content-security-policy': CSP } : {}) });
    res.end(html ? val : JSON.stringify(val, null, 2));
  };
  const sendCsv = (filename, body) => {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`, ...SECURITY });
    res.end(body);
  };
  const redirect = (location, setCookie) => {
    const h = { location, ...SECURITY }; if (setCookie) h['set-cookie'] = setCookie;
    res.writeHead(302, h); res.end();
  };
  // a tracked-session cookie. HttpOnly (no JS access), SameSite=Lax (CSRF defense:
  // the cookie is withheld on cross-site POST, and writes are JSON-only), Secure
  // over https, 7-day lifetime. Pass maxAge 0 to clear it.
  const sessionCookie = (sid, maxAge = 604800) =>
    `atomic_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${tls ? '; Secure' : ''}`;
  try {
    const url = new URL(req.url, 'http://x');
    const cookies = parseCookies(req);
    const origin = `${tls ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    const as = url.searchParams.get('as');                 // html | csv | template
    const wantsHtml = (req.headers.accept || '').includes('text/html') || as === 'html';

    if (req.method === 'GET' && path === 'style.css') {
      res.writeHead(200, { 'content-type': 'text/css', ...SECURITY }); return res.end(CSS);
    }
    if (req.method === 'GET' && path === 'app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', ...SECURITY }); return res.end(APP);
    }

    // --- sign-in: magic link -> tracked session cookie ---
    if (req.method === 'POST' && path === 'auth') {
      const { email } = await readBody(req);
      const tok = [...store.values()].find((a) => a.model === 'atom://token' && a.attr.email === email);
      // Never reveal whether an email maps to a token (no enumeration oracle):
      // issue a link only if it does, but always answer the same shape.
      let link = null;
      if (tok) {
        const code = randomUUID();
        magic.set(code, { token: tok.id, exp: Date.now() + 15 * 60000 });
        link = `${origin}/auth/verify?code=${code}`;
        await sendMagicLink(email, link);
      }
      // dev convenience only: with no mailer configured, surface the link for a
      // real token so local sign-in works. An unknown email still reveals nothing.
      const devLink = link && !SENDGRID ? link : null;
      if (wantsHtml) return send(200, page('Check your email', devLink
        ? `<p>Email is not configured — use this link:</p><p><a href="${devLink}">${esc(devLink)}</a></p>`
        : `<p>If that email has an account, a sign-in link is on its way. It expires in 15 minutes.</p>`), true);
      return send(200, devLink ? { link: devLink } : { sent: true });
    }
    if (req.method === 'GET' && path === 'auth/verify') {
      const code = url.searchParams.get('code');
      const rec = code && magic.get(code);
      if (!rec || rec.exp < Date.now()) return send(401, { error: 'invalid or expired link' });
      magic.delete(code);
      return redirect('/', sessionCookie(newSession(rec.token)));
    }
    if (req.method === 'GET' && path === 'auth/open') {
      const id = url.searchParams.get('token');
      const t = id && store.get(id);
      if (!t || t.model !== 'atom://token' || t.attr.login !== 'open') return send(403, { error: 'not an open-login token' });
      return redirect('/', sessionCookie(newSession(t.id)));
    }
    if (req.method === 'GET' && path === 'auth/logout') {
      const sid = cookies['atomic_session'];
      if (sid && store.has(sid)) store.get(sid).lifecycle.status = 'retired';
      return redirect('/', sessionCookie('', 0));
    }

    const actor = actorFromReq(req, cookies);
    const isAnon = actor.id === '0';
    const [head, ...segs] = path.split('.');

    // A session is a bearer credential, not an addressable resource. No request
    // (any method, any actor) may read, traverse, or write one through the
    // surface — sign-in/out happen only via the /auth/* routes handled above.
    if (head && store.has(head) && getAtom(head).model === 'atom://session')
      throw new Err(404, `no atom ${head}`);

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

    // an atom id may itself contain dots (index ids like 'atom.byDate'); a whole-
    // path match on a real atom wins over dot-path traversal of atom://atom.
    if (req.method === 'GET' && path && store.has(path) && getAtom(path).model === 'atom://index') {
      const ix = getAtom(path);
      if (!visible(actor, ix)) throw new Err(404, `no atom ${path}`); // can't run an index outside your tenant
      const atoms = runIndex(ix, url.search, actor);
      if (as === 'csv') return sendCsv(`${ix.id}.csv`, atomsCsv(refId(ix.attr.over) === 'atom' ? null : refId(ix.attr.over), atoms));
      if (wantsHtml) return send(200, renderIndexPage(ix, atoms, actor, Object.fromEntries(url.searchParams)), true);
      return send(200, atoms);
    }

    if (req.method === 'GET') {
      // atom://atom is the universal type — every atom, newest first
      if (head === 'atom' && segs.length === 0) {
        const atoms = sortBy(getStore(actor).all().filter((a) => readableAtom(actor, a)), '-createdAt')
          .map((a) => redact(actor, a));
        if (wantsHtml) return send(200, page('atom — every atom', renderCrossTable(atoms, actor), navSelect(actor, ''), footer(actor)), true);
        return send(200, atoms);
      }
      const headAtom = getAtom(head);
      const q = parseQuery(url.search);
      let result;
      if (headAtom.model === 'atom://index') {
        if (!visible(actor, headAtom)) throw new Err(404, `no atom ${head}`); // can't run an index outside your tenant
        const atoms = runIndex(headAtom, url.search, actor);
        if (as === 'csv') return sendCsv(`${headAtom.id}.csv`, atomsCsv(refId(headAtom.attr.over) === 'atom' ? null : refId(headAtom.attr.over), atoms));
        if (wantsHtml) return send(200, renderIndexPage(headAtom, atoms, actor, Object.fromEntries(url.searchParams)), true);
        result = atoms;
      } else if (headAtom.model === 'atom://model' && segs.length === 0) {
        // a tenant-scoped model is invisible (and unaddressable) outside its tenant;
        // global/core models (tenant-less) stay listable by everyone.
        if (!visible(actor, headAtom)) throw new Err(404, `no atom ${head}`);
        // a blank template to fill for import (gated on create — you template what you can import)
        if (as === 'template') {
          if (!canOp(actor, head, 'create')) throw new Err(403, `${actor.id} cannot import ${head}`);
          return sendCsv(`${head}-template.csv`, templateCsv(headAtom));
        }
        const atoms = listModel(head, q, actor);                 // already gated by read
        if (as === 'csv') return sendCsv(`${head}.csv`, atomsCsv(head, atoms));
        if (wantsHtml) return send(200, renderModelPage(head, atoms, actor, url.search), true);
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

    if (req.method === 'POST') {
      // IMPORT (bulk create) — POST a CSV body, or a JSON array, to a model. Each
      // row/element runs through create() under the caller's own grants and rules.
      if ((req.headers['content-type'] || '').includes('csv')) {
        const text = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
        return send(200, await bulkCreate(head, csvToBodies(head, text), actor));
      }
      const body = await readBody(req);
      if (Array.isArray(body)) return send(200, await bulkCreate(head, body, actor));
      const a = create(head, body, actor); await runHooks(a, 'create'); return send(201, a);
    }
    if (req.method === 'PUT') { const a = replace(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); return send(200, a); }
    if (req.method === 'PATCH') { const a = update(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); return send(200, a); }
    if (req.method === 'DELETE') { const a = retire(head, actor); await runHooks(a, 'delete'); return send(200, a); }
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    send(e.code || 500, { error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Core atoms — the substrate's own schema: the genesis identities, the core
// model definitions, the expiration conditions/policies, and the core indexes.
// ONE source of truth, consumed two ways: bootstrap() seeds them into a fresh
// store; migrate() ensures any that an older store is missing. Schema, identity,
// and queries are all just atoms, so they all live in the same list.
// ---------------------------------------------------------------------------
function coreAtoms() {
  // system/seed atoms reference the 'never' policy — the substrate's own schema
  // must not expire out from under itself
  const lc = (by = '0', parent = '0') => ({ status: 'active', version: 1, modelVersion: 1, createdAt: now(), updatedAt: now(), createdBy: ref(by), parent: ref(parent), expiration: 'atom://policy-never' });
  const model = (id, label, fields, extra = {}) => ({ id, model: 'atom://model', manifest: label, attr: { label, version: 1, fields, ...extra }, lifecycle: lc('0') });
  const atom = (id, kind, manifest, attr, by = '0') => ({ id, model: `atom://${kind}`, manifest, attr, lifecycle: lc(by) });
  return [
    // genesis: joey is the root authority; atom://0 is the public/anonymous
    // identity that also describes the app (no data grants — what an
    // unauthenticated caller sees).
    atom('joey', 'token', 'Joey — admin', { email: 'joey@emailjoey.com', grants: [{ path: '**', mode: 'all' }] }, 'joey'),
    atom('0', 'token', 'A data substrate where schema, data, identity, permissions, and every surface are all atoms — one organism, generated from the same core atoms and rendered on any surface.', {}, 'joey'),

    // core model definitions (the kernel's own types are model atoms)
    model('model',  'Model',  { label: { kind: 'text' }, fields: { kind: 'map', required: true },
      indexes: { kind: 'map' }, rules: { kind: 'json' }, display: { kind: 'json' }, behavior: { kind: 'json' } }),
    model('token',  'Token',  { email: { kind: 'email' }, login: { kind: 'enum', values: ['open'] },
      grants: { kind: 'list', of: 'embed://grant' }, roles: { kind: 'list' } }),
    model('grant',  'Grant',  { path: { kind: 'text', required: true },
      mode: { kind: 'enum', values: ['read', 'create', 'update', 'delete', 'write', 'all'] } }),
    model('role',   'Role',   { label: { kind: 'text' }, grants: { kind: 'list', of: 'embed://grant' } }),
    model('tenant', 'Tenant', { name: { kind: 'text', required: true } }),
    model('index',  'Index',  { label: { kind: 'text' }, over: { kind: 'ref', to: 'atom://model' },
      params: { kind: 'map' }, match: { kind: 'json' }, sort: { kind: 'list' }, returns: { kind: 'text' } }),
    model('log',    'Log',    { atom: { kind: 'ref', to: 'atom://atom' }, op: { kind: 'text' },
      actor: { kind: 'ref', to: 'atom://token' }, session: { kind: 'ref', to: 'atom://session' },
      at: { kind: 'datetime' }, changes: { kind: 'list' } }),
    model('session','Session',{ token: { kind: 'ref', to: 'atom://token' },
      createdAt: { kind: 'datetime' }, expiresAt: { kind: 'datetime' } }),
    // `run` names a vetted script in scripts/ — constrained to a bare basename
    // (no slashes/dots) so it can never traverse out of the scripts directory.
    model('hook',   'Hook',   { label: { kind: 'text' },
      run: { kind: 'text', required: true, pattern: '^[a-z0-9][a-z0-9-]*$' },
      grants: { kind: 'list', of: 'embed://grant' } }),
    // a one-way schema transform: moves a model from version `from` to `to`. The
    // model atom exists and validates; applying migrations on read is still TODO.
    model('migration', 'Migration', { model: { kind: 'ref', to: 'atom://model' },
      from: { kind: 'integer' }, to: { kind: 'integer' },
      op: { kind: 'enum', values: ['rename', 'default', 'custom'] }, spec: { kind: 'json' }, run: { kind: 'text' } }),
    model('file',   'File',   { name: { kind: 'text' }, contentType: { kind: 'text' },
      size: { kind: 'integer' }, data: { kind: 'longtext' } }),
    model('config', 'Config', { key: { kind: 'text', required: true }, value: { kind: 'json' } }),
    model('plugin', 'Plugin', { name: { kind: 'text', required: true }, version: { kind: 'integer' },
      models: { kind: 'list' }, indexes: { kind: 'list' }, handlers: { kind: 'list' } }),
    // a condition is an atom { field, op, value } — a single reusable predicate.
    // op `older`/`newer` compares a date field against a duration (e.g. 3y) before now.
    model('condition', 'Condition', { label: { kind: 'text' }, field: { kind: 'text', required: true },
      op: { kind: 'enum', values: ['eq', 'ne', 'in', 'older', 'newer'] }, value: { kind: 'json' } }),
    // a policy is a set of condition atoms; lifecycle.expiration points at one.
    // An atom expires when ALL the policy's conditions hold (none → never expires).
    model('policy', 'Policy', { label: { kind: 'text' },
      conditions: { kind: 'list', of: { kind: 'ref', to: 'atom://condition' } } }),

    // root expiration conditions + policies — every atom's lifecycle.expiration
    // points at a policy; policies are made of condition atoms.
    atom('cond-stale-3y', 'condition', 'Not updated in 3 years', { label: 'Not updated in 3 years', field: 'updatedAt', op: 'older', value: '3y' }),
    atom('policy-never',   'policy', 'Never expires', { label: 'Never', conditions: [] }),
    atom('policy-default', 'policy', 'Expires 3 years after last update', { label: '3 years since update', conditions: ['atom://cond-stale-3y'] }),

    // core indexes (queries are atoms too) — named <model>.<qualifier>; also the
    // worked examples of the grammar. dotted ids route via whole-path match.
    atom('log.byAtom', 'index', 'Full change history for one atom', { label: 'Log by atom', over: 'atom://log', params: { atom: { kind: 'ref', to: 'atom://atom' } }, match: { atom: 'params.atom' }, sort: [{ at: 'asc' }], returns: 'set' }),
    atom('atom.byDate', 'index', 'Atoms across all models, newest first', { label: 'Atoms by date', over: 'atom://atom', sort: [{ createdAt: 'desc' }], page: { cursor: 'createdAt', limit: 25 }, returns: 'page' }),
    atom('model.all', 'index', 'Every model in the substrate', { label: 'All models', over: 'atom://model', sort: [{ id: 'asc' }], returns: 'set' }),
    atom('atom.byModel', 'index', 'Atoms of a chosen model', { label: 'Atoms by model', over: 'atom://atom', params: { model: { kind: 'ref', to: 'atom://model' } }, match: { model: 'params.model' }, sort: [{ createdAt: 'desc' }], returns: 'set' }),
  ];
}

// ---------------------------------------------------------------------------
// Bootstrap — fresh store: seed every core atom, then log each as genesis.
// Demo tenants A / B / C / D are loaded from seed-*.mjs (POSTed through the API
// as the admin) so they never bloat the kernel.
// ---------------------------------------------------------------------------
function bootstrap() {
  for (const a of coreAtoms()) seed(a);
  buildInverse();
  // genesis ledger: every seeded atom is itself a logged change — everything is logged
  for (const a of [...store.values()]) {
    if (a.model === 'atom://log') continue;
    const by = typeof a.lifecycle === 'object' ? refId(a.lifecycle.createdBy) : '0';
    logIt(a.id, 'genesis', by, changeset({}, a.attr));
  }
}

// Migration — runs on every durable load. Idempotently ensures every core atom
// exists, so a store written by an earlier kernel gains anything added since,
// and backfills lifecycle.expiration on atoms that predate the field. A fresh
// store is seeded by bootstrap instead; the append-only log + replay means a
// live store can always be evolved forward.
function migrate() {
  const core = coreAtoms();
  let added = 0, refreshed = 0;
  for (const a of core) {
    if (!store.has(a.id)) { seed(a); added++; continue; }
    // keep the core MODEL definitions current: their schema (fields/rules/etc.)
    // is the substrate's own, versioned with the kernel — so an older store gains
    // new field kinds, write rules, and validation as the kernel evolves. Only
    // core models are refreshed; tenant data and demo models are never touched.
    if (a.model === 'atom://model') {
      const cur = store.get(a.id);
      if (JSON.stringify(cur.attr) !== JSON.stringify(a.attr)) { cur.attr = a.attr; bump(cur, '0'); refreshed++; }
    }
  }
  // the root atom is the app's own self-description, carried in its manifest
  // (it holds no data — attr is empty). Keep an older store's copy tracking the
  // canonical definition; the header tagline renders straight from this manifest.
  const root = store.get('0'), def0 = core.find((a) => a.id === '0');
  if (root && def0 && (root.manifest !== def0.manifest || Object.keys(root.attr || {}).length)) {
    root.manifest = def0.manifest;
    root.attr = {}; // atom://0 holds no data, only its label
    bump(root, '0');
  }
  let n = 0;
  for (const a of store.values()) {
    if (a.lifecycle && typeof a.lifecycle === 'object' && !a.lifecycle.expiration) {
      a.lifecycle.expiration = tenantOf(a) === null ? 'atom://policy-never' : 'atom://policy-default';
      persist(a); n++;
    }
  }
  buildInverse();
  if (added || refreshed || n) console.log(`migrate: +${added} core atoms, refreshed ${refreshed} core models, backfilled expiration on ${n}`);
}

// ---------------------------------------------------------------------------
// Governance — `node kernel.mjs --audit` (or `npm run audit`). A self-check over
// the loaded store, in the spirit of a fsck: it asserts the substrate's own
// invariants and exits non-zero on any finding, so it slots into CI / a cron.
// Point it at a real store with ATOMIC_STORE=… (and ATOMIC_KEY=… if encrypted).
// ---------------------------------------------------------------------------
function audit() {
  const PSEUDO = new Set(['atom']); // atom://atom is the universal pseudo-model, not a stored atom
  const atoms = [...store.values()];
  const findings = [];
  const report = (label, bad) => {
    console.log(`${bad.length ? 'FAIL' : ' ok '}  ${label}${bad.length ? `  (${bad.length})` : ''}`);
    for (const b of bad.slice(0, 8)) console.log(`        - ${b}`);
    if (bad.length > 8) console.log(`        … ${bad.length - 8} more`);
    if (bad.length) findings.push(label);
  };
  const refsIn = (v) => { // every atom:// id reachable inside a value (attr or lifecycle)
    const out = [];
    (function walk(x) {
      if (isRef(x)) out.push(refId(x));
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    })(v);
    return out;
  };

  // every atom's model is a real model atom
  report('every atom resolves to a model', atoms.filter((a) => {
    const m = store.get(refId(a.model));
    return !m || m.model !== 'atom://model';
  }).map((a) => `${a.id} → ${a.model}`));

  // every atom:// reference in data resolves (the 'atom' pseudo-model excepted)
  const dangling = new Set();
  for (const a of atoms) for (const id of [...refsIn(a.attr), ...refsIn(a.lifecycle)])
    if (!PSEUDO.has(id) && !store.has(id)) dangling.add(`${a.id} → atom://${id}`);
  report('every reference resolves', [...dangling]);

  // every atom's attr conforms to its model's declared schema
  report('every atom conforms to its schema', atoms.filter((a) => {
    try { validate(refId(a.model), a.attr); return false; } catch { return true; }
  }).map((a) => a.id));

  // every grant is well-formed: a known mode and a non-empty path
  const MODES = new Set(['read', 'create', 'update', 'delete', 'write', 'all']);
  const badGrants = [];
  for (const a of atoms) for (const g of (a.attr?.grants || []))
    if (!g || !g.path || !MODES.has(g.mode)) badGrants.push(`${a.id}: ${JSON.stringify(g)}`);
  report('every grant is well-formed', badGrants);

  // every ledger entry is well-formed: a known op, with a subject + actor.
  // (Global contiguity is NOT an invariant — tenants are independent shards a
  //  node may carry or drop, which legitimately gaps the global log counter.)
  const OPS = new Set(['genesis', 'create', 'merge', 'update', 'replace', 'delete', 'hook']);
  report('every ledger entry is well-formed', atoms.filter((a) => a.model === 'atom://log')
    .filter((a) => !OPS.has(a.attr?.op) || !isRef(a.attr?.atom) || !isRef(a.attr?.actor))
    .map((a) => `${a.id}: op=${a.attr?.op}`));

  // every atom's parent resolves (the tenant walk has no dangling ancestor)
  report('every parent resolves', atoms.filter((a) => {
    const p = a.lifecycle?.parent;
    return isRef(p) && refId(p) !== a.id && !store.has(refId(p));
  }).map((a) => `${a.id} → ${a.lifecycle.parent}`));

  console.log(`\naudit: ${store.size} atoms, ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  return findings.length ? 1 : 0;
}

if (loadAll()) {                 // durable store on disk -> replay it
  buildInverse();
  logSeq = [...store.values()].reduce((m, a) => a.id.startsWith('log-') ? Math.max(m, +a.id.slice(4) || 0) : m, 0);
  migrate();                     // evolve an older store forward (idempotent)
} else {
  bootstrap();                   // fresh -> seed (and persist, if ATOMIC_STORE is set)
}

if (process.argv.includes('--audit')) process.exit(audit()); // governance check, then stop — never listens

const PORT = process.env.PORT || 7777;
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${store.size} atoms${ROOT ? `, persisted -> ${ROOT}` : ', in-memory'})`);
});

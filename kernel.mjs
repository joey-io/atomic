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
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Store + ledger
// ---------------------------------------------------------------------------

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
function seed(atom) { store.set(atom.id, atom); return atom; }

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

function checkKind(key, def, val) {
  const fail = (want) => { throw new Err(400, `field "${key}" must be ${want}`); };
  switch (def.kind) {
    case 'text': case 'longtext': if (typeof val !== 'string') fail('text'); break;
    case 'integer': if (!Number.isInteger(val)) fail('an integer'); break;
    case 'number': if (typeof val !== 'number') fail('a number'); break;
    case 'boolean': if (typeof val !== 'boolean') fail('a boolean'); break;
    case 'datetime': if (typeof val !== 'string') fail('a datetime string'); break;
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

function actorFromReq(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && store.has(m[1])) return getAtom(m[1]);
  return getAtom('anon');
}

const grantsOf = (actor) => actor.attr?.grants || [];

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

const canRead  = (actor, target) => grantsOf(actor).some((x) => grantMatch(x.path, target));
const canWrite = (actor, target) =>
  grantsOf(actor).some((x) => x.mode === 'write' && grantMatch(x.path, target));

function redact(actor, atom) {
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
  seed({
    id, model: 'atom://log', manifest: `${op} ${atomId}`,
    attr: { atom: ref(atomId), op, actor: ref(actorId), at: now(), changes },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(actorId) },
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
  if (!fields.every((f) => canWrite(actor, `${modelId}.${f}`)))
    throw new Err(403, `${actor.id} cannot write ${modelId}`);

  const attr = validate(modelId, body.attr || {});

  // identity dedup -> merge instead of duplicate
  const existing = findByIdentity(modelId, attr, modelAtom);
  if (existing) {
    const before = { ...existing.attr };
    const merge = modelAtom.attr.behavior?.merge || 'merge';
    existing.attr = merge === 'replace' ? attr : { ...existing.attr, ...attr };
    existing.lifecycle.version++;
    existing.lifecycle.updatedAt = now();
    existing.lifecycle.updatedBy = ref(actor.id);
    logIt(existing.id, 'merge', actor.id, changeset(before, existing.attr));
    return existing;
  }

  const id = body.id || randomUUID().slice(0, 8);
  const atom = {
    id, model: ref(modelId),
    manifest: body.manifest || '',
    attr,
    lifecycle: {
      status: 'active', version: 1,
      modelVersion: modelAtom.attr.version || 1,
      createdAt: now(), createdBy: ref(actor.id),
    },
  };
  seed(atom);
  if (modelId === 'model') buildInverse(); // a new model may declare inverse edges
  logIt(id, 'create', actor.id, changeset({}, attr));
  return atom;
}

function update(id, body, actor, ifMatch) {
  const atom = getAtom(id);
  const modelId = refId(atom.model);
  const fields = Object.keys(body.attr || {});
  if (!fields.every((f) => canWrite(actor, `${modelId}.${f}`)))
    throw new Err(403, `${actor.id} cannot write ${modelId}`);
  if (ifMatch != null && Number(ifMatch) !== atom.lifecycle.version)
    throw new Err(409, `version conflict: have ${atom.lifecycle.version}, sent ${ifMatch}`);

  const before = { ...atom.attr };
  atom.attr = validate(modelId, { ...atom.attr, ...body.attr });
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(actor.id);
  logIt(id, 'update', actor.id, changeset(before, atom.attr));
  return atom;
}

function retire(id, actor) {
  const atom = getAtom(id);
  atom.lifecycle.status = 'retired';
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(actor.id);
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

function passes(atom, f) {
  const v = atom.attr?.[f.field];
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
    const a = x.attr?.[key], b = y.attr?.[key];
    const c = a < b ? -1 : a > b ? 1 : 0;
    return desc ? -c : c;
  });
}

function listModel(modelId, q, actor) {
  let atoms = [...store.values()].filter(
    (a) => a.model === ref(modelId) && a.lifecycle?.status !== 'retired');
  for (const f of q.filters) atoms = atoms.filter((a) => passes(a, f));
  atoms = sortBy(atoms, q.sort);
  return atoms.map((a) => redact(actor, a));
}

function runIndex(indexAtom, search, actor) {
  const over = refId(indexAtom.attr.over);
  const params = new URLSearchParams(search);
  const match = indexAtom.attr.match || {};
  let atoms = [...store.values()].filter(
    (a) => a.model === ref(over) && a.lifecycle?.status !== 'retired');
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
  return atoms.map((a) => redact(actor, a));
}

// ---------------------------------------------------------------------------
// Tiny HTML rendering (UI generated from field kinds)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cell = (v) => isRef(v) ? `<a href="/${esc(refId(v))}">${esc(v)}</a>`
  : Array.isArray(v) ? v.map(cell).join(', ') : esc(v ?? '');

function page(title, body) {
  return `<!doctype html><meta charset=utf8><title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:2rem;color:#111}a{color:#06c}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}
th{background:#f6f6f6}h1{font-size:1.1rem}</style><h1>${esc(title)}</h1>${body}`;
}

function renderModelTable(modelId, atoms) {
  const m = getAtom(modelId);
  const cols = m.attr.display?.row || Object.keys(m.attr.fields || {});
  const head = ['id', ...cols].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = atoms.map((a) =>
    `<tr><td><a href="/${esc(a.id)}">${esc(a.id)}</a></td>` +
    cols.map((c) => `<td>${cell(a.attr?.[c])}</td>`).join('') + '</tr>').join('');
  return page(`${m.attr.label || modelId} — ${atoms.length}`, `<table><tr>${head}</tr>${rows}</table>`);
}

function renderAtom(atom) {
  const rows = Object.entries(atom.attr || {})
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${cell(v)}</td></tr>`).join('');
  return page(atom.manifest || atom.id, `<table>${rows}</table>`);
}

// ---------------------------------------------------------------------------
// HTTP surface — one address space, data or rendered view
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, val, html) => {
    res.writeHead(code, { 'content-type': html ? 'text/html' : 'application/json' });
    res.end(html ? val : JSON.stringify(val, null, 2));
  };
  try {
    const actor = actorFromReq(req);
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    const wantsHtml = (req.headers.accept || '').includes('text/html') ||
                      url.searchParams.get('as') === 'html';

    // POST /auth — magic link (stubbed: returns the bearer to use)
    if (req.method === 'POST' && path === 'auth') {
      const { email } = await readBody(req);
      const tok = [...store.values()].find(
        (a) => a.model === 'atom://token' && a.attr.email === email);
      if (!tok) return send(404, { error: 'no token for that email' });
      return send(200, { link: `${url.origin}/?session=${tok.id}`, use: `Authorization: Bearer ${tok.id}` });
    }

    const [head, ...segs] = path.split('.');

    if (req.method === 'GET') {
      if (path === '') {
        const models = [...store.values()].filter((a) => a.model === 'atom://model').map((a) => a.id);
        return send(200, { atomic: 'minimal kernel', models, ledger: `${logSeq} entries` });
      }
      const headAtom = getAtom(head);
      const q = parseQuery(url.search);
      let result;
      if (headAtom.model === 'atom://index') result = runIndex(headAtom, url.search, actor);
      else if (headAtom.model === 'atom://model' && segs.length === 0) {
        const atoms = listModel(head, q, actor);
        if (wantsHtml) return send(200, renderModelTable(head, atoms), true);
        result = atoms;
      } else if (segs.length) result = traverse(headAtom, segs);
      else {
        const a = redact(actor, headAtom);
        if (wantsHtml) return send(200, renderAtom(a), true);
        result = a;
      }
      return send(200, result);
    }

    if (req.method === 'POST') return send(201, create(head, await readBody(req), actor));
    if (req.method === 'PATCH')
      return send(200, update(head, await readBody(req), actor, req.headers['if-match']));
    if (req.method === 'DELETE') return send(200, retire(head, actor));
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    send(e.code || 500, { error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap — joey seeds atom://0 and the core models; then a CRM tenant
// ---------------------------------------------------------------------------

function bootstrap() {
  const lc = (by) => ({ status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(by) });
  const model = (id, label, fields, extra = {}) => seed({
    id, model: 'atom://model', manifest: label,
    attr: { label, version: 1, fields, ...extra }, lifecycle: lc('0'),
  });

  // genesis: joey -> atom://0 -> core models
  seed({ id: 'joey', model: 'atom://token', manifest: 'Joey (founding operator)',
    attr: { grants: [{ path: '**', mode: 'write' }] }, lifecycle: lc('joey') });
  seed({ id: '0', model: 'atom://token', manifest: 'Root token',
    attr: { grants: [{ path: '**', mode: 'write' }] }, lifecycle: lc('joey') });

  // core model definitions (the kernel's own types are model atoms)
  model('model',  'Model',  { label: { kind: 'text' }, fields: { kind: 'map', required: true },
    indexes: { kind: 'map' }, rules: { kind: 'json' }, display: { kind: 'json' }, behavior: { kind: 'json' } });
  model('token',  'Token',  { email: { kind: 'text' }, tenant: { kind: 'ref', to: 'atom://tenant' },
    team: { kind: 'ref', to: 'atom://team' }, grants: { kind: 'list' } });
  model('tenant', 'Tenant', { name: { kind: 'text', required: true } });
  model('index',  'Index',  { label: { kind: 'text' }, over: { kind: 'ref', to: 'atom://model' },
    params: { kind: 'map' }, match: { kind: 'json' }, sort: { kind: 'list' }, returns: { kind: 'text' } });
  model('log',    'Log',    { atom: { kind: 'ref', to: 'atom://atom' }, op: { kind: 'text' },
    actor: { kind: 'ref', to: 'atom://token' }, at: { kind: 'datetime' }, changes: { kind: 'list' } });
  model('team',   'Team',   { name: { kind: 'text', required: true } });

  // CRM models
  model('company', 'Company', {
    name: { kind: 'text', required: true }, domain: { kind: 'text' }, hq: 'embed://address',
    owner: { kind: 'ref', to: 'atom://token' },
    tier: { kind: 'enum', values: ['smb', 'mid', 'enterprise'], filterable: true },
  }, {
    indexes: { byDomain: { on: ['domain'], role: 'identity' }, byName: { on: ['name'], role: 'identity' } },
    display: { row: ['name', 'tier'] },
  });
  model('address', 'Address', { street: { kind: 'text' }, city: { kind: 'text' },
    state: { kind: 'text' }, zip: { kind: 'text' }, country: { kind: 'text', default: 'US' } });
  model('contact', 'Contact', {
    name: { kind: 'text', required: true }, email: { kind: 'text' }, title: { kind: 'text' },
    company: { kind: 'ref', to: 'atom://company', inverse: 'contacts' },
  }, { indexes: { byEmail: { on: ['email'], role: 'identity' } }, display: { row: ['name', 'title', 'company'] } });
  model('deal', 'Deal', {
    name: { kind: 'text', required: true },
    amount: { kind: 'number', filterable: true, sortable: true },
    stage: { kind: 'enum', values: ['lead', 'qualified', 'won', 'lost'], filterable: true },
    company: { kind: 'ref', to: 'atom://company', inverse: 'deals' },
    owner: { kind: 'ref', to: 'atom://token' },
  }, { display: { row: ['name', 'amount', 'stage'] } });

  // stored indexes (queries are atoms too — including queries over the log)
  seed({ id: 'openDeals', model: 'atom://index', manifest: 'Open deals for a company',
    attr: { label: 'Open deals', over: 'atom://deal', params: { company: { kind: 'ref', to: 'atom://company' } },
      match: { company: 'params.company', stage: { in: ['lead', 'qualified'] } },
      sort: [{ amount: 'desc' }], returns: 'set' }, lifecycle: lc('0') });
  seed({ id: 'atomLog', model: 'atom://index', manifest: 'Full change history for one atom',
    attr: { label: 'Atom log', over: 'atom://log', params: { atom: { kind: 'ref', to: 'atom://atom' } },
      match: { atom: 'params.atom' }, sort: [{ at: 'asc' }], returns: 'set' }, lifecycle: lc('0') });

  // tenant + tokens (the people and integrations are all tokens)
  seed({ id: 'acme', model: 'atom://tenant', manifest: 'Acme, Inc.', attr: { name: 'Acme, Inc.' }, lifecycle: lc('0') });
  seed({ id: 'team-west', model: 'atom://team', manifest: 'West team', attr: { name: 'West' }, lifecycle: lc('0') });
  seed({ id: 'tok-amy', model: 'atom://token', manifest: 'Amy Chen',
    attr: { email: 'amy@acme.com', tenant: 'atom://acme', team: 'atom://team-west',
      grants: [{ path: '**', mode: 'write' }] }, lifecycle: lc('0') });
  seed({ id: 'tok-read', model: 'atom://token', manifest: 'Read-limited viewer',
    attr: { email: 'view@acme.com', tenant: 'atom://acme',
      grants: [{ path: 'contact.name', mode: 'read' }, { path: 'contact.title', mode: 'read' }] }, lifecycle: lc('0') });
  seed({ id: 'tok-outreach', model: 'atom://token', manifest: 'Outreach integration',
    attr: { tenant: 'atom://acme', grants: [{ path: 'contact.*', mode: 'write' }] }, lifecycle: lc('tok-amy') });
  seed({ id: 'anon', model: 'atom://token', manifest: 'Anonymous public caller',
    attr: { grants: [{ path: 'registration.*', mode: 'write' }] }, lifecycle: lc('0') });

  buildInverse();
}

bootstrap();
const PORT = process.env.PORT || 7777;
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${store.size} atoms seeded)`);
});

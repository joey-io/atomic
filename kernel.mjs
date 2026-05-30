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

const magic = new Map(); // one-time sign-in codes: code -> { token, exp }

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

// can the actor touch anything under this top-level name (a model or index id)?
const canTouch = (actor, name) =>
  grantsOf(actor).some((x) => { const s = x.path.split('.')[0]; return s === name || s === '*' || s === '**'; });

// can the actor create atoms of this model (a write grant covering it)?
const canCreate = (actor, modelId) =>
  grantsOf(actor).some((x) =>
    x.mode === 'write' && (() => { const s = x.path.split('.')[0]; return s === modelId || s === '*' || s === '**'; })());

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
  let atoms = [...store.values()].filter(
    (a) => a.model === ref(modelId) && a.lifecycle?.status !== 'retired');
  for (const f of q.filters) atoms = atoms.filter((a) => passes(a, f));
  atoms = sortBy(atoms, q.sort);
  return atoms.map((a) => redact(actor, a));
}

function runIndex(indexAtom, search, actor) {
  const over = refId(indexAtom.attr.over);
  const all = over === 'atom';                 // pseudo-model atom://atom = every atom
  const params = new URLSearchParams(search);
  const match = indexAtom.attr.match || {};
  let atoms = [...store.values()].filter((a) =>
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

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cell = (v) => isRef(v) ? `<a href="/${esc(refId(v))}">${esc(v)}</a>`
  : Array.isArray(v) ? v.map(cell).join(', ') : esc(v ?? '');

function page(title, body) {
  return `<!doctype html><meta charset=utf8>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:1.25rem;color:#111;max-width:100%;overflow-wrap:anywhere}
a{color:#06c}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}
th{background:#f6f6f6}h1{font-size:1.1rem}input,select{font:inherit;padding:2px 4px}</style>
<h1>${esc(title)}</h1>${body}`;
}

function renderTable(modelId, atoms) {
  const m = getAtom(modelId);
  const cols = m.attr.display?.row || Object.keys(m.attr.fields || {});
  const head = ['id', ...cols].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = atoms.map((a) =>
    `<tr><td><a href="/${esc(a.id)}">${esc(a.id)}</a></td>` +
    cols.map((c) => `<td>${cell(a.attr?.[c])}</td>`).join('') + '</tr>').join('');
  return `<table><tr>${head}</tr>${rows}</table>`;
}

// atom://0 as the public, JSON-LD-shaped description of the app
function appDescriptor(origin) {
  const a = getAtom('0');
  const cat = (m) => [...store.values()].filter((x) => x.model === m)
    .map((x) => ({ '@id': ref(x.id), name: x.attr.label || x.id, url: `${origin}/${x.id}` }));
  return {
    '@context': 'https://schema.org',
    '@type': 'WebAPI',
    '@id': 'atom://0',
    name: a.attr.name || 'Atomic',
    description: a.attr.description || '',
    provider: 'atom://joey',
    models: cat('atom://model'),
    indexes: cat('atom://index'),
    potentialAction: { '@type': 'AuthenticateAction', target: `${origin}/auth`, method: 'magic-link' },
  };
}

function renderApp(d) {
  const li = (xs) => xs.map((x) => `<li>${esc(x.name)} <code>${esc(x['@id'])}</code></li>`).join('');
  return page(d.name, `<p>${esc(d.description)}</p>
<h1>Types</h1><ul>${li(d.models)}</ul>
<h1>Queries</h1><ul>${li(d.indexes)}</ul>
<h1>Sign in</h1><form method="post" action="/auth">
<p><label>email <input name="email" type="email" placeholder="amy@acme.com"></label></p>
<button>Send magic link</button></form>
<p><small>demo: <code>amy@acme.com</code> (admin) · <code>view@acme.com</code> (read-only contacts)</small></p>`);
}

// add form generated from the model's field kinds; POSTs JSON with the session cookie
function renderForm(modelId) {
  const m = getAtom(modelId);
  const inputs = Object.entries(m.attr.fields || {})
    .filter(([, d]) => typeof d === 'object')
    .map(([k, def]) => {
      if (def.kind === 'enum')
        return `<p><label>${esc(k)} <select name="${esc(k)}">${def.values.map((v) => `<option>${esc(v)}</option>`).join('')}</select></label></p>`;
      if (def.kind === 'boolean')
        return `<p><label><input type="checkbox" name="${esc(k)}"> ${esc(k)}</label></p>`;
      const type = (def.kind === 'integer' || def.kind === 'number') ? 'number' : 'text';
      const ph = def.kind === 'ref' ? ' placeholder="atom://…"' : '';
      return `<p><label>${esc(k)} <input type="${type}" name="${esc(k)}" data-kind="${esc(def.kind)}"${ph}></label></p>`;
    }).join('');
  return `<h1>Add ${esc(m.attr.label || modelId)}</h1><form id="add">${inputs}<button>Create</button></form>
<script>
document.getElementById('add').onsubmit=async function(e){e.preventDefault();var attr={};
e.target.querySelectorAll('[name]').forEach(function(el){
  if(el.type==='checkbox'){attr[el.name]=el.checked;return;}
  if(el.value==='')return;
  attr[el.name]=(el.dataset.kind==='number'||el.dataset.kind==='integer')?Number(el.value):el.value;});
var r=await fetch('/'+${JSON.stringify(modelId)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attr:attr})});
if(r.ok){location.reload();}else{var j=await r.json();alert(j.error||'error');}};
</script>`;
}

function renderModelPage(modelId, atoms, actor) {
  const m = getAtom(modelId);
  const form = canCreate(actor, modelId) ? renderForm(modelId) : '';
  return page(`${m.attr.label || modelId} — ${atoms.length}`, renderTable(modelId, atoms) + form);
}

// cross-model table for indexes that span all models (over: atom://atom)
function renderCrossTable(atoms) {
  const head = ['id', 'model', 'manifest', 'createdAt'].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = atoms.map((a) =>
    `<tr><td><a href="/${esc(a.id)}">${esc(a.id)}</a></td><td>${cell(a.model)}</td>` +
    `<td>${esc(a.manifest || '')}</td><td>${esc(a.lifecycle?.createdAt || '')}</td></tr>`).join('');
  return `<table><tr>${head}</tr>${rows}</table>`;
}

function renderIndexPage(indexAtom, atoms) {
  const over = refId(indexAtom.attr.over);
  let body = over === 'atom' ? renderCrossTable(atoms) : renderTable(over, atoms);
  const pg = indexAtom.attr.page;
  if (pg && atoms.length) {
    const last = atoms[atoms.length - 1];
    const cur = (last.lifecycle?.[pg.cursor]) ?? last.attr?.[pg.cursor];
    body += `<p><a href="/${indexAtom.id}?before=${encodeURIComponent(cur)}">older →</a></p>`;
  }
  return page(`${indexAtom.attr.label || indexAtom.id} — ${atoms.length}`, body);
}

function renderAtom(atom) {
  const rows = Object.entries(atom.attr || {})
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${cell(v)}</td></tr>`).join('');
  return page(atom.manifest || atom.id, `<table>${rows}</table>`);
}

function renderHome(h) {
  const models = h.models.map((m) =>
    `<li><a href="/${m.id}">${esc(m.label)}</a> <code>atom://${m.id}</code></li>`).join('');
  const idx = h.indexes.map((i) =>
    `<li><a href="/${i.id}">${esc(i.label)}</a> <small>over ${esc(i.over)}</small></li>`).join('');
  return page('Atomic', `<p>signed in as <code>${esc(h.actor)}</code> · ${h.atoms} atoms · ${h.ledger} in the ledger · <a href="/auth/logout">sign out</a></p>
<h1>Models</h1><ul>${models || '<li><em>none visible</em></li>'}</ul>
<h1>Indexes</h1><ul>${idx || '<li><em>none visible</em></li>'}</ul>`);
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

    // --- sign-in: magic link -> tracked session cookie ---
    if (req.method === 'POST' && path === 'auth') {
      const { email } = await readBody(req);
      const tok = [...store.values()].find((a) => a.model === 'atom://token' && a.attr.email === email);
      if (!tok) return send(404, { error: 'no token for that email' });
      const code = randomUUID();
      magic.set(code, { token: tok.id, exp: Date.now() + 15 * 60000 });
      const link = `${origin}/auth/verify?code=${code}`;
      if (wantsHtml) return send(200, page('Check your email',
        `<p>Magic link for <code>${esc(email)}</code> — normally emailed, shown here for the demo:</p>
<p><a href="${link}">${esc(link)}</a></p>`), true);
      return send(200, { link });
    }
    if (req.method === 'GET' && path === 'auth/verify') {
      const code = url.searchParams.get('code');
      const rec = code && magic.get(code);
      if (!rec || rec.exp < Date.now()) return send(401, { error: 'invalid or expired link' });
      magic.delete(code);
      const sid = newSession(rec.token);
      return redirect('/', `atomic_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    }
    if (req.method === 'GET' && path === 'auth/logout') {
      const sid = cookies['atomic_session'];
      if (sid && store.has(sid)) store.get(sid).lifecycle.status = 'retired';
      return redirect('/', 'atomic_session=; Path=/; Max-Age=0');
    }

    const actor = actorFromReq(req, cookies);
    const isAnon = actor.id === '0';
    const [head, ...segs] = path.split('.');

    // anonymous caller -> the app describes itself at the root (atom://0, JSON-LD)
    if (req.method === 'GET' && path === '' && isAnon) {
      const d = appDescriptor(origin);
      return send(200, wantsHtml ? renderApp(d) : d, wantsHtml);
    }
    // no anonymous access to anything else: browsers land on the descriptor, APIs get 401
    if (isAnon) {
      if (wantsHtml) return redirect('/');
      return send(401, { error: 'authenticate: POST /auth { email } or Authorization: Bearer <token>' });
    }

    if (req.method === 'GET') {
      if (path === '') {
        const models = [...store.values()]
          .filter((a) => a.model === 'atom://model' && canTouch(actor, a.id))
          .map((a) => ({ id: a.id, label: a.attr.label || a.id, url: `/${a.id}` }));
        const indexes = [...store.values()]
          .filter((a) => a.model === 'atom://index' &&
            (canTouch(actor, a.id) || canTouch(actor, refId(a.attr.over))))
          .map((a) => ({ id: a.id, label: a.attr.label || a.id, over: a.attr.over, url: `/${a.id}` }));
        const home = { atomic: 'minimal kernel', actor: ref(actor.id),
          atoms: store.size, ledger: logSeq, models, indexes };
        if (wantsHtml) return send(200, renderHome(home), true);
        return send(200, home);
      }
      const headAtom = getAtom(head);
      const q = parseQuery(url.search);
      let result;
      if (headAtom.model === 'atom://index') {
        const atoms = runIndex(headAtom, url.search, actor);
        if (wantsHtml) return send(200, renderIndexPage(headAtom, atoms), true);
        result = atoms;
      } else if (headAtom.model === 'atom://model' && segs.length === 0) {
        const atoms = listModel(head, q, actor);
        if (wantsHtml) return send(200, renderModelPage(head, atoms, actor), true);
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
  // joey is the root authority; atom://0 is the public/anonymous identity that
  // also describes the app (no data grants — it is what an unauthenticated caller sees).
  seed({ id: 'joey', model: 'atom://token', manifest: 'Joey (founding operator, root authority)',
    attr: { grants: [{ path: '**', mode: 'write' }] }, lifecycle: lc('joey') });
  seed({ id: '0', model: 'atom://token', manifest: 'Atomic (public root + anonymous identity)',
    attr: { name: 'Atomic',
      description: 'A data substrate where schema, data, identity, and the UI surface are all atoms.',
      grants: [] }, lifecycle: lc('joey') });

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
  model('session','Session',{ token: { kind: 'ref', to: 'atom://token' },
    createdAt: { kind: 'datetime' }, expiresAt: { kind: 'datetime' } });

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
  seed({ id: 'recent', model: 'atom://index', manifest: 'Recent atoms across all models',
    attr: { label: 'Recent', over: 'atom://atom', sort: [{ createdAt: 'desc' }],
      page: { cursor: 'createdAt', limit: 25 }, returns: 'page' }, lifecycle: lc('0') });

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
  // demo records — so the live instance has data to navigate (in-memory: reseeded each start)
  seed({ id: 'northwind', model: 'atom://company', manifest: 'Northwind Traders, enterprise account',
    attr: { name: 'Northwind Traders', domain: 'northwind.com',
      hq: { street: '500 Market St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' },
      owner: 'atom://tok-amy', tier: 'enterprise' }, lifecycle: lc('tok-amy') });
  seed({ id: 'jane', model: 'atom://contact', manifest: 'Jane Roe, VP Eng at Northwind',
    attr: { name: 'Jane Roe', email: 'jane@northwind.com', title: 'VP Engineering', company: 'atom://northwind' },
    lifecycle: lc('tok-amy') });
  seed({ id: 'john', model: 'atom://contact', manifest: 'John Vega, CFO at Northwind',
    attr: { name: 'John Vega', email: 'john@northwind.com', title: 'CFO', company: 'atom://northwind' },
    lifecycle: lc('tok-amy') });
  seed({ id: 'deal-9001', model: 'atom://deal', manifest: 'Northwind platform expansion',
    attr: { name: 'Platform expansion', amount: 120000, stage: 'qualified', company: 'atom://northwind', owner: 'atom://tok-amy' },
    lifecycle: lc('tok-amy') });

  buildInverse();

  // genesis ledger: every seeded atom is itself a logged change — everything is logged
  for (const a of [...store.values()]) {
    if (a.model === 'atom://log') continue;
    const by = typeof a.lifecycle === 'object' ? refId(a.lifecycle.createdBy) : '0';
    logIt(a.id, 'genesis', by, changeset({}, a.attr));
  }
}

bootstrap();
const PORT = process.env.PORT || 7777;
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${store.size} atoms seeded)`);
});

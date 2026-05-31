// Atomic — the most minimal kernel.
//
// One store of atoms. The schema is atoms. Identity is a token atom.
// CRUD is the ledger. The HTTP surface is generated from the atoms.
//
// Dependency-free. Run: node atomic.mjs   (Node >= 22.5 for node:sqlite; >= 24 unflagged)
//
// In-memory by default; point ATOMIC_STORE at a directory for durable, indexed,
// ACID persistence in embedded SQLite (node:sqlite) — authoritative on disk,
// optionally AES-256-GCM encrypted at rest. It implements the full load-bearing
// model from the README: CRUD, grants, tenancy, hooks, lazy expiration, and lazy
// schema migration (version-bump rewrite on read).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite'; // embedded SQLite — part of the Node runtime, not a dependency

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

// The stylesheet, inlined so atomic.mjs is the whole program. Served at /style.css.
const CSS = `/* Atomic — one small, variable-driven sheet. No classes, no ids: every rule
   targets a semantic element. A data grid is a <table> with a <thead> (inside a
   <figure> that scrolls); a key/value or form table is a bare <table>; a
   repeater is a <fieldset>. The structure carries the meaning. */
:root {
  --font: 'Noto Sans', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  --fg: #16181d;
  --muted: #6b7280;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --line: #e7e9ee;
  --line-strong: #d3d7df;
  --head: #f3f5f8;
  --row: #fbfcfd;
  --accent: #2f6df6;
  --accent-weak: #eaf1ff;
  --radius-sm: 8px;
  --cell: 9px 14px;
  --gap: 10px;
  --title: 12vw;
  --nest: rgba(0, 0, 0, .01); /* translucent so nested figures accumulate/darken */
  --nest-line: rgba(0, 0, 0, .1); /* figure border: same hue as --nest, heavier */
  --asc: " ↑";
  --desc: " ↓";
}

* { box-sizing: border-box }
html { -webkit-text-size-adjust: 100% }
body {
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
}
header { max-width: 1120px; margin: 0 auto; padding: 24px 24px 0 }
h1 { margin: 0; font-size: var(--title); font-weight: 700; letter-spacing: -.02em; line-height: 1.1 }
h1 a { color: var(--fg) }
h1 a:hover { text-decoration: none }
main { display: block; max-width: 1120px; margin: 0 auto; padding: 8px 24px 64px }
nav { max-width: 1120px; margin: 0 auto; padding: 1rem 24px 8px; display: flex; gap: var(--gap); align-items: center }
header p { margin: 0; color: var(--muted); font-size: .82rem; max-width: 80vw }
p { margin: 14px 0 }
small { color: var(--muted) }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em }

a { color: var(--accent); text-decoration: none }
a:hover { text-decoration: underline }

/* ONE table component, everywhere. A <figure> scrolls it; every table is a grid
   with a sortable <thead>. Same cells, same headers, same separators — no
   variants, no exceptions. Rule #1: everything is the same. */
figure { margin: 14px 0; overflow-x: auto; max-width: 100%; background: var(--nest); border: 1px solid var(--nest-line); border-radius: 1rem; padding-top: 1rem }
table { width: 100%; border-collapse: collapse; background: transparent }
th, td { text-align: left; vertical-align: top; white-space: nowrap; padding: var(--cell) }
td { border-bottom: 1px solid var(--line) }
thead th {
  color: var(--muted);
  font-weight: 600;
  font-size: .76rem;
  letter-spacing: .04em;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}
thead th:hover { color: var(--fg) }
tbody tr:hover > td { background: var(--accent-weak) }
tbody tr:last-child > td { border-bottom: 0 }
thead th[data-dir="1"]::after { content: var(--asc); color: var(--accent) }
thead th[data-dir="-1"]::after { content: var(--desc); color: var(--accent) }

/* forms — controls and a repeater (<fieldset>) */
label { font-weight: 500 }
input, select, textarea {
  font: inherit;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  min-width: 18rem;
  max-width: 100%;
}
textarea { width: 100% }
input[type="checkbox"] { min-width: 0 }
input:focus, select:focus, textarea:focus {
  outline: 0;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
select { cursor: pointer }

button {
  font: inherit; font-weight: 600;
  color: #fff; background: var(--accent);
  border: 1px solid var(--accent); border-radius: var(--radius-sm);
  padding: 8px 16px; cursor: pointer;
}
button:hover { filter: brightness(.94) }
button:active { filter: brightness(.88) }
button[type="button"] {
  color: var(--accent); background: var(--surface); border-color: var(--line-strong);
  padding: 5px 12px; font-weight: 500;
}
button[type="button"]:hover { border-color: var(--accent); background: var(--accent-weak) }

nav select { min-width: 0; max-width: 360px }

fieldset {
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: var(--gap); margin: 0 0 var(--gap);
  display: flex; flex-direction: column; gap: var(--gap); align-items: flex-start;
}
fieldset fieldset { background: var(--row) }

/* nav actions (export CSV) sit beside the dropdown */
nav a { font-size: .82rem; font-weight: 500 }

/* the CSV import dropzone: a dashed drop target, highlighted while dragging over */
figure[data-import] { border-style: dashed; text-align: center; color: var(--muted); padding: 18px }
figure[data-import] p { margin: 6px 0 }
figure[data-import] input { min-width: 0 }
[data-over] { border-color: var(--accent); background: var(--accent-weak); color: var(--fg) }`;

// Atomic — the whole client. Two behaviours, both progressive: click-to-sort on
// any data grid, and the generated create/edit form's submit + repeater. Served
// static and same-origin so the page can run under a strict CSP (script-src
// 'self', no inline script). The form is data-driven: it reads its target URLs
// from data-create / data-atom on the <form>, so this file is page-agnostic.
// It lives here as a real function and is served as its own source via toString()
// at request time — actual JavaScript (regexes and all), never an escaped blob.
const CLIENT = function () {
  function num(s) { return /^-?[\d,]+(\.\d+)?$/.test(s) ? parseFloat(s.replace(/,/g, '')) : null; }

  // sortable data grids: a <table> with a <thead>, not inside a form
  document.querySelectorAll('table').forEach(function (t) {
    if (t.closest('form') || !t.tHead) return;
    var body = t.tBodies[0] || t;
    t.tHead.querySelectorAll('th').forEach(function (th, ci) {
      th.addEventListener('click', function () {
        var dir = th.getAttribute('data-dir') === '1' ? -1 : 1;
        t.tHead.querySelectorAll('th').forEach(function (o) { o.removeAttribute('data-dir'); });
        th.setAttribute('data-dir', dir);
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (a, b) {
          var x = ((a.cells[ci] || {}).innerText || '').trim(), y = ((b.cells[ci] || {}).innerText || '').trim();
          var nx = num(x), ny = num(y); var c = (nx !== null && ny !== null) ? nx - ny : x.localeCompare(y); return c * dir;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
  });

  // nav dropdown: jump to the selected ref. Wired here (not an inline onchange)
  // so it runs under the strict CSP, and before the no-form early-return below so
  // it works on read-only pages too.
  document.querySelectorAll('select[data-nav]').forEach(function (sel) {
    sel.addEventListener('change', function () { if (sel.value) location.href = sel.value; });
  });

  // the generated create/edit form (present only when the actor may write here)
  var F = document.querySelector('form[data-create]');
  if (!F) return;
  var createUrl = F.getAttribute('data-create'), atomUrl = F.getAttribute('data-atom') || '';

  function setPath(root, path, val) {
    var ks = path.split('.'), o = root;
    for (var i = 0; i < ks.length - 1; i++) { var k = ks[i], nn = /^[0-9]+$/.test(ks[i + 1]); if (o[k] === undefined) o[k] = nn ? [] : {}; o = o[k]; }
    o[ks[ks.length - 1]] = val;
  }

  // list repeaters: "+ add" clones the last fieldset, renumbering its inputs
  F.querySelectorAll('button[type="button"]').forEach(function (btn) {
    btn.onclick = function () {
      var box = btn.parentElement, name = box.getAttribute('data-name');
      var items = box.querySelectorAll(':scope > fieldset'), last = items.length - 1, c = items[last].cloneNode(true);
      c.querySelectorAll('[name]').forEach(function (el) {
        el.name = el.name.split(name + '.' + last + '.').join(name + '.' + items.length + '.');
        if (el.type === 'checkbox') el.checked = false; else el.value = '';
      });
      box.insertBefore(c, btn);
    };
  });

  F.onsubmit = async function (e) {
    e.preventDefault();
    var method = e.target.querySelector('[name="$method"]').value;
    if (method === 'IMPORT') return; // the dropzone handles the upload, not submit
    var url = method === 'POST' ? createUrl : atomUrl;
    var opts = { method: method, headers: { 'content-type': 'application/json' } };
    if (method === 'DELETE') { if (!confirm('Delete ' + atomUrl + '?')) return; }
    else {
      var body = {}, attr = {}, bad = null;
      e.target.querySelectorAll('[name]').forEach(function (el) {
        var n = el.name;
        if (n === '$method') return;
        if (n === '$id') { if (el.value) body.id = el.value; return; }
        if (n === '$manifest') { body.manifest = el.value; return; }
        var val;
        if (el.type === 'checkbox') val = el.checked;
        else if (el.dataset.kind === 'json') { if (el.value === '') return; try { val = JSON.parse(el.value); } catch (_) { bad = n; return; } }
        else { if (el.value === '') return; val = el.dataset.kind === 'number' ? Number(el.value) : el.value; }
        setPath(attr, n, val);
      });
      if (bad) { alert('invalid JSON in ' + bad); return; }
      body.attr = attr; opts.body = JSON.stringify(body);
    }
    var r = await fetch(url, opts);
    if (r.ok) { location.href = method === 'DELETE' ? createUrl : (method === 'POST' ? createUrl : atomUrl); }
    else { var j = await r.json(); alert(j.error || 'error'); }
  };

  // IMPORT method: reveal the template + dropzone, hide the normal create rows,
  // and upload the dropped/picked CSV to the model (the API bulk-creates it).
  var methodSel = F.querySelector('[name="$method"]');
  var importRow = F.querySelector('[data-import-row]');
  if (methodSel && importRow) {
    var submitBtn = F.querySelector('p > button');
    var rows = F.querySelectorAll('table tr');
    var syncImport = function () {
      var imp = methodSel.value === 'IMPORT';
      importRow.hidden = !imp;
      rows.forEach(function (tr) { if (tr !== importRow && !tr.contains(methodSel)) tr.hidden = imp; });
      if (submitBtn) submitBtn.hidden = imp;
    };
    methodSel.addEventListener('change', syncImport); syncImport();

    var DZ = importRow.querySelector('[data-import]'), dzUrl = DZ.getAttribute('data-import');
    var upload = async function (file) {
      if (!file) return;
      var text = await file.text();
      var resp = await fetch(dzUrl, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      var j = await resp.json().catch(function () { return {}; });
      if (!resp.ok && j.imported === undefined) { alert(j.error || ('import failed: ' + resp.status)); return; }
      var msg = 'Imported ' + (j.imported || 0) + ' row(s).';
      if (j.failed && j.failed.length) msg += '\n' + j.failed.length + ' failed:\n' +
        j.failed.slice(0, 8).map(function (f) { return (f.id || ('row ' + f.row)) + ': ' + f.error; }).join('\n');
      alert(msg);
      if (j.imported) location.reload();
    };
    ['dragenter', 'dragover'].forEach(function (ev) { DZ.addEventListener(ev, function (e) { e.preventDefault(); DZ.setAttribute('data-over', '1'); }); });
    ['dragleave', 'dragend'].forEach(function (ev) { DZ.addEventListener(ev, function () { DZ.removeAttribute('data-over'); }); });
    DZ.addEventListener('drop', function (e) { e.preventDefault(); DZ.removeAttribute('data-over'); upload(e.dataTransfer.files[0]); });
    var fi = DZ.querySelector('input[type="file"]');
    if (fi) fi.addEventListener('change', function () { upload(fi.files[0]); });
  }
};
const APP = `(${CLIENT})();`; // the IIFE source served at /app.js
let   store;                  // id -> atom; assigned once ROOT + the persistence helpers
                              // are defined below: a SQLite driver (ROOT set) or in-memory Map
let   logSeq = 0;             // ledger sequence
const invReg = {};            // inverseName -> { sourceModel, field, targetModel }

const now = () => new Date().toISOString();
const isRef = (v) => typeof v === 'string' && v.startsWith('atom://');
const refId = (v) => v.slice('atom://'.length);
const ref   = (id) => `atom://${id}`;
// an embed field inlines another model's shape, by reference — the reusable-shape
// mechanism. Two spellings: the string shorthand `'embed://<model>'`, or the object
// form `{ kind: 'embed', of: 'atom://<model>', required? }` (which can also be required).
// embedOf(def) returns the embedded model id (bare), or null if def isn't an embed.
const embedOf = (def) =>
  typeof def === 'string' ? (def.startsWith('embed://') ? def.slice('embed://'.length) : null)
  : (def && def.kind === 'embed' && def.of) ? (isRef(def.of) ? refId(def.of) : def.of) : null;

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
function seed(atom) { store.set(atom.id, atom); storeGen++; return atom; }

// ---------------------------------------------------------------------------
// Inverse-edge registry (built from model atoms)
// ---------------------------------------------------------------------------

function buildInverse() {
  for (const k of Object.keys(invReg)) delete invReg[k];
  for (const a of store.query({ model: 'atom://model' })) {
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

function inverseList(targetId, inv, actor) {
  const out = [];
  for (const a of store.query({ model: ref(inv.sourceModel) })) {
    if (a.lifecycle?.status !== 'retired' && a.attr?.[inv.field] === ref(targetId)
        && (!actor || canSee(actor, a.id)))     // an actor-scoped read only sees backlinks it may open
      out.push(ref(a.id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path resolution: read across fields, edges, and inverse edges. When an `actor`
// is supplied (the HTTP read path), every ref hop and every attribute read is
// gated exactly like the whole-atom view — a path can never reach an atom the
// actor can't open, nor a field it can't read. Omit the actor (rule evaluation)
// to traverse ungated, as the system.
// ---------------------------------------------------------------------------

const deref = (node, actor) => {
  if (!isRef(node)) return node;
  const a = getAtom(refId(node));
  if (actor && !canSee(actor, a.id)) throw new Err(404, `no atom ${refId(node)}`); // can't cross into an unreadable/foreign atom
  return a;
};

function readField(node, seg, actor) {
  if (node == null) throw new Err(404, `null before .${seg}`);
  if (Array.isArray(node)) return node.map((n) => readField(deref(n, actor), seg, actor));
  if (isAtomObj(node)) {
    if (node.attr && seg in node.attr) {
      // per-attribute read grant — the same redaction the whole-atom view applies,
      // so a path can't reach an attribute the actor couldn't see directly.
      if (actor && !canRead(actor, `${refId(node.model)}.${seg}`)) throw new Err(404, `no field .${seg} on ${node.id}`);
      return node.attr[seg];
    }
    if (node.lifecycle && typeof node.lifecycle === 'object' && seg in node.lifecycle)
      return node.lifecycle[seg];
    const inv = invReg[seg];
    if (inv && inv.targetModel === refId(node.model)) return inverseList(node.id, inv, actor);
    // virtual `.tenant` edge: every atom's nearest tenant ancestor, as a ref (or
    // null at the global root). Lets rules read `actor.tenant` / `atom.tenant`
    // without a stored field. Only a fallback — a real `tenant` attr wins above.
    if (seg === 'tenant') { const t = tenantOf(node); return t ? ref(t) : null; }
    throw new Err(404, `no field .${seg} on ${node.id}`);
  }
  if (typeof node === 'object') return node[seg];
  throw new Err(404, `cannot read .${seg} of a scalar`);
}

function traverse(start, segs, actor) {
  if (segs.length > 16) throw new Err(400, 'path exceeds traversal budget'); // budget/cycle guard
  let node = start;
  for (const seg of segs) node = readField(deref(node, actor), seg, actor);
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
    // an embed inlines another model's shape (string shorthand or { kind:'embed', of, required }).
    // A required embed must be present; when present it must be an object, and its own
    // required fields are enforced by the recursive validate — required propagates inward.
    const sub = embedOf(def);
    if (sub) {
      const ev = attr[key];
      if (ev === undefined) {
        if (def.required) throw new Err(400, `missing required field "${key}"`);
        continue;
      }
      if (typeof ev !== 'object' || ev === null || Array.isArray(ev))
        throw new Err(400, `field "${key}" must be an embedded ${sub} object`);
      out[key] = validate(sub, ev); // returns a plain, validated object
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
    for (const a of store.query({ model: ref(modelId) })) {
      if (a.lifecycle?.status === 'retired') continue;
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
  // so e.g. `Bearer northwind` (a company id) can't be presented as an identity —
  // and the token must still be live: retiring or expiring a token revokes it (the
  // session path below already checks this; the Bearer path must too).
  if (m && store.has(m[1])) {
    const t = getAtom(m[1]);
    if (t.model === 'atom://token' && t.lifecycle?.status !== 'retired' && !isExpired(t)) return t;
  }
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

// Attenuation: a token (or hook) may only be issued with grants that are a subset
// of the issuer's own — it can never grant more than it holds. This covers BOTH
// inline `grants` AND `roles`: a role confers its grants on every token that wears
// it, so a referenced role must be visible to the issuer and hold nothing beyond
// the issuer's own — otherwise roles would be an attenuation bypass (mint a `**`
// role, then wear it). Runs on every token/hook create and update.
function attenuate(actor, modelId, attr) {
  if (!['token', 'hook'].includes(modelId)) return;
  const within = (cg) => grantsOf(actor).some((g) => grantMatch(g.path, cg.path) && permits(g.mode, cg.mode));
  for (const cg of (Array.isArray(attr.grants) ? attr.grants : []))
    if (!within(cg)) throw new Err(403, `cannot grant ${cg.mode} ${cg.path}: it exceeds your own grants`);
  for (const r of (Array.isArray(attr.roles) ? attr.roles : [])) {
    const role = store.get(isRef(r) ? refId(r) : r);
    if (!role || role.model !== 'atom://role') throw new Err(400, `not a role: ${r}`);
    if (!visible(actor, role)) throw new Err(403, `cannot wear role ${r} (out of scope)`);
    for (const cg of (role.attr.grants || []))
      if (!within(cg)) throw new Err(403, `cannot wear role ${r}: it grants ${cg.mode} ${cg.path} beyond your own`);
  }
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
  // a tenant-less (global) TOKEN is a system credential, not shared reference data:
  // only a superuser may see it. This keeps the root admin token from leaking to a
  // tenant user who happens to hold a `token` read grant — global tokens shouldn't
  // be world-visible the way the core models or shared reference atoms are. The one
  // exception is atom://0, the public app descriptor every caller is meant to see.
  if (atom.model === 'atom://token' && at === null && atom.id !== '0') return ut === null;
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
    // tenant scoping pushed into the store: root (no tenant) sees every shard;
    // a tenant user sees only the global shard plus its own. So a read never
    // even materializes another tenant's atoms.
    const ut = tenantOf(actor);
    const shards = ut === null ? null : ['_global', ut];
    hit = { gen: storeGen, list: store.query({ shards }).filter((a) => a.model !== 'atom://session' && visible(actor, a)) };
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
const shardOf = (atom) => tenantOf(atom) || '_global';

// Encryption at rest (opt-in). Set ATOMIC_KEY to a 64-char hex key or any
// passphrase (stretched with scrypt). When set, an atom's payload is sealed as
// `enc:<base64(iv12 ‖ tag16 ‖ ciphertext)>` under AES-256-GCM — confidential and
// tamper-evident (GCM auth tag). Unset → plaintext (the default). Reads accept
// either form per row, so turning the key on is forward-only and a store written
// without it still loads. (The structural columns id/shard/model stay plaintext
// so the engine can route and index on them; only the atom body — where the data
// lives — is sealed.)
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
  if (!KEY) throw new Err(500, 'store is encrypted but ATOMIC_KEY is not set');
  const buf = Buffer.from(line.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

// --- The store: one logical id->atom map, two drivers behind one interface ---
// Every reader and writer in the kernel talks to `store` through five methods:
// get(id) · set(id, atom) · has(id) · delete(id) · values() · size. Swapping the
// driver swaps the substrate; nothing else moves. `persist(atom)` is the durable
// write-back used by in-place mutators (bump/migrate) and is just store.set.
function memStore() {                                   // in-memory (no ATOMIC_STORE): the default
  const m = new Map();
  let snapshot = null;            // deep pre-transaction copy; non-null only inside a tx
  return {
    get: (id) => m.get(id), set: (id, a) => m.set(id, a), has: (id) => m.has(id),
    delete: (id) => m.delete(id), values: () => [...m.values()], get size() { return m.size; },
    // scoped read: the rows in `shards` (null = all) of type `model` (null = any).
    query({ shards = null, model = null } = {}) {
      const out = [];
      for (const a of m.values()) {
        if (model && a.model !== model) continue;
        if (shards && !shards.includes(shardOf(a))) continue;
        out.push(a);
      }
      return out;
    },
    // Transactions. This driver hands out live atom references that the kernel
    // mutates in place (bump), so a shallow copy would alias those mutations —
    // begin() takes a deep snapshot and rollback() restores it wholesale. That is
    // O(store) per transaction, but this is the in-RAM default; the durable path
    // below uses SQLite's native BEGIN/COMMIT, which is O(changes).
    begin()    { snapshot = new Map(); for (const [k, v] of m) snapshot.set(k, structuredClone(v)); },
    commit()   { snapshot = null; },
    rollback() { if (snapshot) { m.clear(); for (const [k, v] of snapshot) m.set(k, v); snapshot = null; } },
    close() {},
  };
}
// node:sqlite (ATOMIC_STORE set): one durable, indexed, ACID WAL-mode atoms.db.
// State lives authoritatively in the `atom` table — there is no boot-time replay
// of a log and no requirement that the working set fit in RAM. `shard` (= tenant)
// and `model` are kept as plaintext indexed columns so reads can be scoped to a
// tenant / model in SQL (the lever that takes this to billions of atoms/tenant);
// the atom body is stored as one TEXT cell, sealed when ATOMIC_KEY is set.
function sqliteStore() {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = new DatabaseSync(path.join(ROOT, 'atoms.db'));
  db.exec('PRAGMA journal_mode = WAL');     // many concurrent readers + one writer; crash-safe
  db.exec('PRAGMA synchronous = NORMAL');   // fsync at checkpoint — durable across process crash
  db.exec('CREATE TABLE IF NOT EXISTS atom (id TEXT PRIMARY KEY, shard TEXT NOT NULL, model TEXT NOT NULL, body TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS atom_by_shard ON atom(shard)');
  db.exec('CREATE INDEX IF NOT EXISTS atom_by_model ON atom(model)');
  const cache = new Map();                                   // sql string -> prepared statement
  const prep = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s; };
  const q = {
    get:   prep('SELECT body FROM atom WHERE id = ?'),
    has:   prep('SELECT 1 FROM atom WHERE id = ?'),
    put:   prep('INSERT INTO atom(id, shard, model, body) VALUES(?, ?, ?, ?) ' +
                'ON CONFLICT(id) DO UPDATE SET shard = excluded.shard, model = excluded.model, body = excluded.body'),
    del:   prep('DELETE FROM atom WHERE id = ?'),
    all:   prep('SELECT body FROM atom'),
    count: prep('SELECT count(*) AS c FROM atom'),
  };
  return {
    get(id)      { const r = q.get.get(id); return r ? parseLine(r.body) : undefined; },
    set(id, a)   { q.put.run(id, shardOf(a), a.model, serializeLine(a)); },
    has(id)      { return !!q.has.get(id); },
    delete(id)   { q.del.run(id); },
    values()     { return q.all.all().map((r) => parseLine(r.body)); },
    get size()   { return Number(q.count.get().c); },
    // scoped read: pushes the tenant (shard) and type (model) filters into SQL so a
    // read hits the atom_by_shard / atom_by_model indexes and never materializes
    // atoms outside its scope — this is what holds up at billions of atoms/tenant.
    query({ shards = null, model = null } = {}) {
      const where = [], params = [];
      if (shards) { where.push(`shard IN (${shards.map(() => '?').join(', ')})`); params.push(...shards); }
      if (model)  { where.push('model = ?'); params.push(model); }
      const sql = 'SELECT body FROM atom' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
      return prep(sql).all(...params).map((r) => parseLine(r.body));
    },
    // Transactions: SQLite's own, on the single writer connection. Reads inside the
    // transaction (same connection) see its uncommitted writes, so a batch's ops
    // observe each other; ROLLBACK reverts every change as one unit. Durable on
    // COMMIT (WAL + synchronous=NORMAL fsyncs at the checkpoint).
    begin()      { db.exec('BEGIN'); },
    commit()     { db.exec('COMMIT'); },
    rollback()   { db.exec('ROLLBACK'); },
    close()      { db.close(); },
  };
}
store = ROOT ? sqliteStore() : memStore();
function persist(atom) { store.set(atom.id, atom); storeGen++; } // durable write-back; bumps the read-memo gen

// --- Transactions. A batch of mutations that commits all-or-nothing. The store
// driver supplies begin/commit/rollback (SQLite's native transaction; a deep
// snapshot for the in-RAM driver). tx(fn) runs fn inside one transaction: on any
// throw the whole batch rolls back and storeGen is bumped so every gen-keyed read
// memo rebuilds against the reverted state. Nested tx() calls join the enclosing
// one, so a mutator that is itself transactional (e.g. a cascading delete) composes
// without opening a second transaction. fn is synchronous — the kernel's mutators
// (create/update/retire) are; their async tails (hooks, migration sweeps) run after
// commit, because a hook's external side-effect cannot be rolled back.
let _txDepth = 0;
function tx(fn) {
  if (_txDepth > 0) return fn();                 // already inside a transaction — join it
  _txDepth++;
  try {
    store.begin();
    try {
      const result = fn();
      store.commit();
      return result;
    } catch (e) {
      store.rollback();
      storeGen++;                                // reverted state invalidates the read memos
      throw e;
    }
  } finally {
    _txDepth--;
  }
}

// One-time migration: fold any legacy per-tenant NDJSON shards (the previous
// on-disk format) into atoms.db, last-write-wins by id, then set them aside as
// .migrated so they are never re-read. A fresh store has none and this is a no-op.
function migrateNdjson() {
  if (!ROOT || !fs.existsSync(ROOT)) return;
  let n = 0;
  for (const shard of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, shard, 'log.ndjson');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n'))
      if (line.trim()) { const a = parseLine(line); store.set(a.id, a); n++; }
    fs.renameSync(f, f + '.migrated');
  }
  if (n) console.log(`migrated ${n} NDJSON log lines into atoms.db`);
}
// Durable data present? (SQLite: rows in atoms.db, after folding any legacy NDJSON.)
function loadAll() {
  if (!ROOT) return false;
  if (store.size === 0) migrateNdjson();
  return store.size > 0;
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

  // POST creates. An explicit id must be a safe slug — it becomes a URL path and is
  // rendered into HTML/links, so reject anything with HTML/URL metacharacters or
  // whitespace (allow letters, digits, and . _ - @ : so dotted index ids and
  // `model@1-2` migration ids still work). An id that already exists is a conflict.
  if (body.id && !/^[A-Za-z0-9._@:-]+$/.test(String(body.id)))
    throw new Err(400, `invalid id "${body.id}" — use letters, digits, and . _ - @ :`);
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

// ---------------------------------------------------------------------------
// Schema evolution (lazy, like expiration). Each model carries a `version`;
// every atom records the `modelVersion` it was written under. A `migration` atom
// is a one-way step that moves a model from version `from` to `to` — `rename` and
// `default` are applied by the kernel from `spec`; `custom` runs a vetted handler
// in scripts/. When an atom is behind its model, the kernel applies the chain of
// migrations in order, returns the current shape, and rewrites the record forward
// (persist + a `migrate` log entry). An atom already at the current version is a
// single integer comparison and a no-op. The sweep runs on read (single atom), on
// every schema change (a model write or a new migration), and to completion on boot.
// ---------------------------------------------------------------------------
const _migs = { gen: -1, byModel: new Map() };
function migrationsByModel() {                          // modelId -> migrations, ordered by `from`
  if (_migs.gen === storeGen) return _migs.byModel;
  const byModel = new Map();
  for (const m of store.query({ model: 'atom://migration' })) {
    if (m.lifecycle?.status === 'retired') continue;
    const mid = isRef(m.attr.model) ? refId(m.attr.model) : m.attr.model;
    if (!mid) continue;
    if (!byModel.has(mid)) byModel.set(mid, []);
    byModel.get(mid).push(m);
  }
  for (const list of byModel.values()) list.sort((a, b) => (a.attr.from ?? 0) - (b.attr.from ?? 0));
  _migs.gen = storeGen; _migs.byModel = byModel;
  return byModel;
}

// apply one migration to an attr bag, returning the next attr (never mutates input)
async function applyMigration(attr, mig) {
  const op = mig.attr.op, spec = mig.attr.spec || {};
  const out = { ...attr };
  if (op === 'rename') {
    const { from, to } = spec;
    if (from && to && from in out) { out[to] = out[from]; delete out[from]; }
  } else if (op === 'default') {
    const { field, value } = spec;
    if (field && out[field] === undefined) out[field] = value;
  } else if (op === 'custom') {
    const run = String(mig.attr.run || '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(run)) { console.error(`migration ${mig.id}: unsafe run "${run}" — skipped`); return out; }
    try {
      const mod = await import(new URL(`./scripts/${run}.mjs`, import.meta.url));
      const next = await mod.default(out, { migration: mig, getAtom, refId, ref });
      return (next && typeof next === 'object' && !Array.isArray(next)) ? next : out;
    } catch (e) { console.error(`migration ${mig.id} (${run}):`, e.message); return out; }
  }
  return out;
}

// bring one atom forward to its model's current version (in place + persisted).
// Applies only the contiguous chain that starts at the atom's modelVersion, so a
// gap in the migration steps stops the walk rather than skipping a version.
async function bringForward(atom) {
  if (!atom?.lifecycle || typeof atom.lifecycle !== 'object') return atom;
  const model = store.get(refId(atom.model));
  if (!model || model.model !== 'atom://model') return atom;
  const target = model.attr.version || 1;
  let v = atom.lifecycle.modelVersion || 1;
  if (v >= target) return atom;
  const chain = migrationsByModel().get(refId(atom.model)) || [];
  const before = { ...atom.attr };
  let attr = atom.attr, changed = false;
  for (const mig of chain) {
    const from = mig.attr.from ?? 0, to = mig.attr.to ?? 0;
    // only the next contiguous step, and it must STRICTLY advance toward target —
    // a from==to (or to<from) migration is ignored, so it can't loop forever
    // re-applying and rewriting on every read.
    if (from !== v || to <= v || to > target) continue;
    attr = await applyMigration(attr, mig);
    v = to; changed = true;
  }
  if (!changed) return atom;            // nothing applicable — leave the version as-is
  atom.attr = attr;
  atom.lifecycle.modelVersion = v;      // modelVersion is the schema clock; the user-write `version` is untouched
  persist(atom);
  logIt(atom.id, 'migrate', '0', changeset(before, attr));
  return atom;
}

// sweep every atom of one model forward (a model write or new migration triggers this)
async function sweepModel(modelId) {
  if (!migrationsByModel().get(modelId)?.length) return;
  for (const a of store.query({ model: ref(modelId) })) await bringForward(a);
}
// sweep every model that has migrations — the boot "background job", run to completion
async function sweepAll() { for (const modelId of migrationsByModel().keys()) await sweepModel(modelId); }

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
  // model + tenant scope both pushed into the store (the atom_by_model / atom_by_shard
  // indexes), so listing one type reads only that type's rows in the actor's scope.
  const ut = tenantOf(actor);
  const shards = ut === null ? null : ['_global', ut];
  let atoms = store.query({ shards, model: ref(modelId) }).filter(
    (a) => a.lifecycle?.status !== 'retired' && visible(actor, a) && ruleOk(actor, a, 'read'));
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
  // scope the scan to the index's model AND the actor's shards — the same
  // index-backed lever listModel uses — instead of materializing every atom in
  // scope just to drop all but one model. atom://atom legitimately spans every
  // model, so it still reads the full in-scope set (sessions excluded by getStore).
  const ut = tenantOf(actor);
  const shards = ut === null ? null : ['_global', ut];
  let atoms = (all
    ? getStore(actor).all().filter((a) => a.model !== 'atom://log')
    : store.query({ shards, model: ref(over) }).filter((a) => a.model !== 'atom://session' && visible(actor, a))
  ).filter((a) => readableAtom(actor, a));
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
// CSV columns: an embed field flattens into dotted sub-columns (one level per embed,
// recursively) so a reusable shape is first-class in a spreadsheet — address.street,
// address.city, … — not one opaque JSON blob. Every non-embed field is one column.
function csvColumns(modelAtom, prefix = '', depth = 0) {
  const cols = [];
  for (const [k, def] of Object.entries(modelAtom.attr.fields || {})) {
    const sub = embedOf(def);
    if (sub && depth < 6) cols.push(...csvColumns(getAtom(sub), `${prefix}${k}.`, depth + 1));
    else cols.push(prefix + k);
  }
  return cols;
}
const dotGet = (obj, parts) => parts.reduce((o, p) => (o == null ? undefined : o[p]), obj);
// header-only template: the shape to fill in for import
const templateCsv = (modelAtom) => csvRow(['id', 'manifest', ...csvColumns(modelAtom)]) + '\n';
// the kind map an importer uses to coerce each cell, keyed by (possibly dotted) column
// name — an embed's sub-columns are coerced by the sub-model's own field kinds.
function csvKinds(modelAtom, prefix = '', depth = 0) {
  const out = {};
  for (const [k, def] of Object.entries(modelAtom.attr.fields || {})) {
    const sub = embedOf(def);
    if (sub && depth < 6) Object.assign(out, csvKinds(getAtom(sub), `${prefix}${k}.`, depth + 1));
    else out[prefix + k] = (typeof def === 'string') ? 'text' : (def.kind || 'text');
  }
  return out;
}
// export a set of atoms. modelId null → cross-model (an index over atom://atom).
function atomsCsv(modelId, atoms) {
  if (!modelId) {
    const lines = [csvRow(['id', 'model', 'manifest', 'createdAt'])];
    for (const a of atoms) lines.push(csvRow([a.id, refId(a.model), a.manifest || '', a.lifecycle?.createdAt || '']));
    return lines.join('\n') + '\n';
  }
  const cols = csvColumns(getAtom(modelId));
  const lines = [csvRow(['id', 'manifest', ...cols])];
  for (const a of atoms) lines.push(csvRow([a.id, a.manifest || '', ...cols.map((c) => dotGet(a.attr, c.split('.')))]));
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
// set a value at a (possibly dotted) path, creating intermediate objects as needed
function dotSet(obj, parts, val) {
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
  o[parts[parts.length - 1]] = val;
}
// a CSV (id, manifest, then fields / dotted sub-fields) → create bodies, coercing each
// cell by its column kind. A dotted header (address.city) rebuilds the embedded object.
function csvToBodies(modelId, text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const kinds = csvKinds(getAtom(modelId));
  const bodies = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.length || cells.every((c) => c === '')) continue;
    const body = { attr: {} };
    header.forEach((h, ci) => {
      const v = cells[ci]; if (v === undefined || v === '') return;
      if (h === 'id') body.id = v;
      else if (h === 'manifest') body.manifest = v;
      else { const cv = coerceCsv(kinds[h] || 'text', v); if (cv !== undefined) dotSet(body.attr, h.split('.'), cv); }
    });
    bodies.push(body);
  }
  return bodies;
}
async function bulkCreate(modelId, bodies, actor, atomic = false) {
  // atomic import (?atomic=1): the whole import is one transaction — a single bad
  // row rolls every row back and surfaces the error, rather than a partial load.
  if (atomic) {
    const made = tx(() => bodies.map((b) => create(modelId, b, actor)));
    for (const a of made) await runHooks(a, 'create');   // hooks fire post-commit
    return { imported: made.length, failed: [] };
  }
  // default: per-row best-effort — each row that validates is kept, each that
  // fails is reported, and the response is a summary (Import is still POST-many).
  const out = { imported: 0, failed: [] };
  for (let i = 0; i < bodies.length; i++) {
    try { const a = create(modelId, bodies[i], actor); await runHooks(a, 'create'); out.imported++; }
    catch (e) { out.failed.push({ row: i, id: bodies[i]?.id || null, error: e.message }); }
  }
  return out;
}

// ---- /tx: an all-or-nothing batch of writes. The body is a JSON array of ops,
// each mirroring a REST verb and dispatched through the same mutator REST uses, so
// grants, attenuation, rules, tenant scope, dedup, and optimistic concurrency all
// apply unchanged. The batch runs inside one transaction (tx): any op throwing
// rolls the whole batch back. Lifecycle hooks and migration sweeps run only after
// the batch commits — a hook may call an external service, which cannot be undone.
const bareId = (v) => (isRef(v) ? refId(v) : String(v));
function applyOp(op, actor, i) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Err(400, `op ${i}: must be an object`);
  const { op: verb, ifMatch, ...body } = op;       // body = the create/update payload (attr, manifest, id, parent, hooks…)
  switch (verb) {
    case 'create':
      if (!op.model) throw new Err(400, `op ${i}: create needs a model`);
      return { atom: create(bareId(op.model), body, actor), event: 'create' };
    case 'update':
      if (!op.id) throw new Err(400, `op ${i}: update needs an id`);
      return { atom: update(bareId(op.id), body, actor, ifMatch), event: 'update' };
    case 'replace':
      if (!op.id) throw new Err(400, `op ${i}: replace needs an id`);
      return { atom: replace(bareId(op.id), body, actor, ifMatch), event: 'update' };
    case 'delete':
      if (!op.id) throw new Err(400, `op ${i}: delete needs an id`);
      return { atom: retire(bareId(op.id), actor), event: 'delete' };
    default:
      throw new Err(400, `op ${i}: unknown op "${verb}" — use create | update | replace | delete`);
  }
}
async function txBatch(ops, actor) {
  if (!Array.isArray(ops)) throw new Err(400, '/tx expects a JSON array of operations');
  if (!ops.length) return { ok: true, results: [] };
  const effects = [];
  tx(() => { for (let i = 0; i < ops.length; i++) effects.push(applyOp(ops[i], actor, i)); });
  // committed — now fire the same post-write tails the REST verbs run, in order.
  for (const { atom, event } of effects) {
    await runHooks(atom, event);
    if (event !== 'delete' && atom.model === 'atom://model') await sweepModel(atom.id);
    if (event === 'create' && atom.model === 'atom://migration') await sweepModel(refId(atom.attr.model));
  }
  return { ok: true, results: effects.map((e) => e.atom) };
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
  const open = store.query({ model: 'atom://token' }).filter((a) => a.attr.login === 'open');
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
  // sub-table, list with a declared item type (`of`) -> a repeater. `depth` guards
  // against a self- or mutually-embedding model (e.g. `self: embed://self`) blowing
  // the stack: past the limit, the field falls back to a raw JSON textarea.
  function control(name, def, v, depth = 0) {
    if (depth > 8) return json(name, v);
    const sub = embedOf(def);
    if (sub) return embed(name, sub, v || {}, depth);
    if (def.kind === 'enum')
      return `<select name="${esc(name)}"><option value="">—</option>${def.values.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (def.kind === 'boolean')
      return `<input type="checkbox" name="${esc(name)}"${v ? ' checked' : ''}>`;
    if (def.kind === 'ref' && def.to)
      return `<input name="${esc(name)}" data-kind="ref" list="refs-${esc(refId(def.to))}" value="${v === undefined ? '' : esc(v)}" placeholder="atom://… or embed://…">`;
    if (def.kind === 'list' && def.of) return repeater(name, def.of, Array.isArray(v) ? v : [], depth);
    if (def.kind === 'json' || def.kind === 'map' || def.kind === 'list') return json(name, v);
    if (def.kind === 'integer' || def.kind === 'number')
      return `<input type="number" name="${esc(name)}" data-kind="number" value="${v === undefined ? '' : esc(v)}">`;
    return `<input type="text" name="${esc(name)}" data-kind="text" value="${v === undefined ? '' : esc(v)}">`;
  }
  function embed(name, subId, obj, depth = 0) {
    const sm = getAtom(subId);
    const rows = Object.entries(sm.attr.fields || {})
      .map(([k, def]) => `<tr><th>${esc(k)}</th><td>${control(name + '.' + k, def, obj?.[k], depth + 1)}</td></tr>`).join('');
    return `<figure><table>${rows}</table></figure>`;
  }
  function repeater(name, ofDef, arr, depth = 0) {
    const items = arr.length ? arr : [undefined];
    const blocks = items.map((it, i) => `<fieldset>${control(name + '.' + i, ofDef, it, depth + 1)}</fieldset>`).join('');
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
    body += `<p><a href="/${esc(indexAtom.id)}?before=${encodeURIComponent(cur)}">older →</a></p>`;
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

// Read the raw request body, capped — a single request can never buffer more than
// MAX_BODY into memory (an unauthenticated POST /auth reads a body too), so a large
// or slow upload is rejected with 413 instead of exhausting the process.
const MAX_BODY = 8 * 1024 * 1024;
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let b = '', len = 0, done = false;
    req.on('data', (c) => {
      if (done) return;             // already over the cap — ignore the rest, don't buffer it
      len += c.length;
      if (len > MAX_BODY) { done = true; reject(new Err(413, 'request body too large')); return; }
      b += c;
    });
    req.on('end', () => { if (!done) { done = true; resolve(b); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
async function readBody(req) {
  const b = await readRaw(req);
  const ct = req.headers['content-type'] || '';
  if (!b) return {};
  if (ct.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(b));
  try { return JSON.parse(b); } catch { return Object.fromEntries(new URLSearchParams(b)); }
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
      const tok = store.query({ model: 'atom://token' }).find((a) => a.attr.email === email);
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
      if (sid && store.has(sid)) { const s = store.get(sid); s.lifecycle.status = 'retired'; store.set(s.id, s); }
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

    // --- /tx: all-or-nothing batch of writes (see txBatch). Body is a JSON array
    // of ops, each mirroring a REST verb:
    //   {op:'create', model, attr, …} · {op:'update'|'replace', id, attr, ifMatch} · {op:'delete', id}
    // A single failure rolls the whole batch back; the response is {ok, results}.
    if (req.method === 'POST' && path === 'tx') return send(200, await txBatch(await readBody(req), actor));

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
      } else if (segs.length) {
        // a dotted path is a read like any other: gate the head atom, then traverse
        // under the actor so every hop and field honors scope + grants + rules.
        if (!canSee(actor, head)) throw new Err(404, `no atom ${head}`);
        result = traverse(headAtom, segs, actor);
      }
      else {
        if (!visible(actor, headAtom) || !canOp(actor, refId(headAtom.model), 'read') || !ruleOk(actor, headAtom, 'read'))
          throw new Err(404, `no atom ${head}`);
        await bringForward(headAtom);             // lazy schema evolution: behind atoms are migrated on read
        const a = redact(actor, headAtom);
        if (wantsHtml) return send(200, renderAtom(a, actor), true);
        result = a;
      }
      return send(200, result);
    }

    if (req.method === 'POST') {
      // IMPORT (bulk create) — POST a CSV body, or a JSON array, to a model. Each
      // row/element runs through create() under the caller's own grants and rules.
      const atomic = url.searchParams.get('atomic') === '1';   // ?atomic=1 → all-or-nothing import
      if ((req.headers['content-type'] || '').includes('csv')) {
        const text = await readRaw(req);  // capped — a CSV import can't exhaust memory either
        return send(200, await bulkCreate(head, csvToBodies(head, text), actor, atomic));
      }
      const body = await readBody(req);
      if (Array.isArray(body)) return send(200, await bulkCreate(head, body, actor, atomic));
      const a = create(head, body, actor); await runHooks(a, 'create');
      if (a.model === 'atom://migration') await sweepModel(refId(a.attr.model)); // a new migration brings its model's atoms forward
      return send(201, a);
    }
    if (req.method === 'PUT') { const a = replace(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); if (a.model === 'atom://model') await sweepModel(a.id); return send(200, a); }
    if (req.method === 'PATCH') { const a = update(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); if (a.model === 'atom://model') await sweepModel(a.id); return send(200, a); }
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
    model('model',  'Model',  { label: { kind: 'text' }, version: { kind: 'integer', default: 1 },
      fields: { kind: 'map', required: true },
      indexes: { kind: 'map' }, rules: { kind: 'json' }, display: { kind: 'json' }, behavior: { kind: 'json' } }),
    model('token',  'Token',  { email: { kind: 'email' }, login: { kind: 'enum', values: ['open'] },
      grants: { kind: 'list', of: 'embed://grant' }, roles: { kind: 'list', of: { kind: 'ref', to: 'atom://role' } } }),
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
    // kernel applies the chain on read and rewrites records forward (see bringForward):
    // `rename`/`default` from `spec`, `custom` via a vetted scripts/<run>.mjs handler.
    model('migration', 'Migration', { model: { kind: 'ref', to: 'atom://model' },
      from: { kind: 'integer' }, to: { kind: 'integer' },
      op: { kind: 'enum', values: ['rename', 'default', 'custom'] }, spec: { kind: 'json' },
      run: { kind: 'text', pattern: '^[a-z0-9][a-z0-9-]*$' } }),
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
// Demo tenants A / B / C / D are loaded from seeds/seed-*.mjs (POSTed through the API
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
async function migrate() {
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
  // schema evolution: bring every atom of a migrated model up to the current
  // version — the "background job, run to completion on boot" (README).
  const sgBefore = storeGen; await sweepAll(); const migrated = storeGen > sgBefore;
  if (added || refreshed || n || migrated) console.log(`migrate: +${added} core atoms, refreshed ${refreshed} core models, backfilled expiration on ${n}, applied schema migrations`);
}

// ---------------------------------------------------------------------------
// Governance — `node atomic.mjs --audit` (or `npm run audit`). A self-check over
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
  const OPS = new Set(['genesis', 'create', 'merge', 'update', 'replace', 'delete', 'hook', 'migrate']);
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
  await migrate();               // evolve an older store forward (idempotent): core atoms + schema migrations
} else {
  bootstrap();                   // fresh -> seed (and persist, if ATOMIC_STORE is set)
}

if (process.argv.includes('--audit')) process.exit(audit()); // governance check, then stop — never listens

const PORT = process.env.PORT || 3040; // matches the seeds' default base and the documented live port
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${store.size} atoms${ROOT ? `, persisted -> ${ROOT}` : ', in-memory'})`);
});

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
import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite'; // embedded SQLite — part of the Node runtime, not a dependency
import { AsyncLocalStorage } from 'node:async_hooks'; // scopes a transaction's connection (Postgres driver)

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

/* inline-editable grid cells — click a cell, type, Tab to the next. A subtle
   affordance only on the editable ones; saved flashes, conflicts/errors outline. */
td[data-edit] { cursor: text }
td[data-edit] select, td[data-edit] input { min-width: 0 }
td[data-edit] input[type="checkbox"] { cursor: pointer }
td[contenteditable]:focus { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--surface); border-radius: 4px }
td[data-busy] { opacity: .5 }
td[data-saved] { background: var(--accent-weak) }
td[data-error] { outline: 2px solid #c0392b; outline-offset: -2px }

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

  // inline grid editing — a [data-edit] cell PATCHes its single field on blur/change
  // with If-Match optimistic concurrency. The update path, per-field grants, and the
  // version already exist server-side; this is only the wiring. Runs before the form
  // early-return below, so the grid is editable on list pages with no create form.
  function cellRaw(td) {
    var ip = td.querySelector('select, input');
    return ip ? (ip.type === 'checkbox' ? ip.checked : ip.value) : td.textContent.trim();
  }
  function revert(td) {
    var ip = td.querySelector('select, input'), o = td.getAttribute('data-orig');
    if (ip && ip.type === 'checkbox') ip.checked = (o === 'true');
    else if (ip) ip.value = o; else td.textContent = o;
  }
  function commitCell(td) {
    var raw = cellRaw(td);
    if (td.getAttribute('data-orig') === String(raw)) return;          // unchanged → no write
    var kind = td.getAttribute('data-kind');
    var val = (kind === 'number') ? (raw === '' ? null : Number(raw)) : raw;
    if (kind === 'number' && val !== null && isNaN(val)) { revert(td); td.setAttribute('data-error', '1'); td.title = 'not a number'; return; }
    var attr = {}; attr[td.getAttribute('data-field')] = val;
    td.removeAttribute('data-error'); td.removeAttribute('data-saved'); td.setAttribute('data-busy', '1');
    fetch('/' + td.getAttribute('data-id'), { method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': td.getAttribute('data-ver') },
      body: JSON.stringify({ attr: attr }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; },
        function () { return { ok: r.ok, status: r.status, j: {} }; }); })
      .then(function (res) {
        td.removeAttribute('data-busy');
        if (res.ok) {
          td.setAttribute('data-ver', res.j.lifecycle.version);       // advance version for the next edit
          td.setAttribute('data-orig', String(raw)); td.removeAttribute('title');
          td.setAttribute('data-saved', '1'); setTimeout(function () { td.removeAttribute('data-saved'); }, 900);
        } else if (res.status === 409) {
          td.setAttribute('data-error', '1'); td.title = 'changed elsewhere — reloading';
          setTimeout(function () { location.reload(); }, 800);         // someone else won; resync
        } else {
          revert(td); td.setAttribute('data-error', '1'); td.title = (res.j && res.j.error) || ('error ' + res.status);
        }
      })
      .catch(function () { td.removeAttribute('data-busy'); revert(td); td.setAttribute('data-error', '1'); td.title = 'network error'; });
  }
  document.querySelectorAll('td[data-edit]').forEach(function (td) {
    td.setAttribute('data-orig', String(cellRaw(td)));
    var ip = td.querySelector('select, input');
    if (ip) ip.addEventListener('change', function () { commitCell(td); });
    else {
      td.addEventListener('focus', function () { td.setAttribute('data-orig', td.textContent.trim()); td.removeAttribute('data-error'); td.removeAttribute('title'); });
      td.addEventListener('blur', function () { commitCell(td); });
      td.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); td.blur(); }     // commit; Tab moves to next cell natively
        else if (e.key === 'Escape') { e.preventDefault(); td.textContent = td.getAttribute('data-orig'); td.blur(); }
      });
    }
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
// the storage interface is async (Phase 1 of the Postgres port): every store
// method returns a Promise, so array methods that take async predicates won't
// await them. asyncFilter keeps a .filter over an async predicate honest —
// each element is awaited in order, preserving the original order.
async function asyncFilter(arr, pred) { const out = []; for (const a of arr) if (await pred(a)) out.push(a); return out; }
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

// Control-plane cache. The few atoms read over and over for every decision — the
// schema (models), identity (tokens, roles), retention (policies, conditions),
// tenancy (tenants), and queries/automations (indexes, hooks, migrations) — are
// small and change rarely, yet a list re-reads the same policy/condition/tenant once
// per row. Caching them turns those repeats into Map hits instead of a store round-
// trip + JSON parse each (the per-atom fan-out the async refactor made expensive).
// Data atoms are never cached. Kept fresh on write (persist/seed); single-process,
// like the other gen-keyed memos. getCached returns atom-or-undefined (no throw).
const _ctl = new Map();
const CONTROL_MODELS = new Set(['atom://model', 'atom://token', 'atom://role', 'atom://policy',
  'atom://condition', 'atom://tenant', 'atom://index', 'atom://hook', 'atom://migration']);
async function getCached(id) {
  const c = _ctl.get(id);
  if (c !== undefined) return c;
  const a = await store.get(id);
  if (a && CONTROL_MODELS.has(a.model)) _ctl.set(id, a);
  return a;
}
async function getAtom(id) {
  const a = await getCached(id);
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
async function seed(atom) { await store.set(atom.id, atom); if (store.setIndex) await store.setIndex(atom.id, await shardOf(atom), atom.model, await indexRows(atom)); if (CONTROL_MODELS.has(atom.model)) _ctl.set(atom.id, atom); storeGen++; return atom; }

// ---------------------------------------------------------------------------
// Inverse-edge registry (built from model atoms)
// ---------------------------------------------------------------------------

async function buildInverse() {
  for (const k of Object.keys(invReg)) delete invReg[k];
  for (const a of await store.query({ model: 'atom://model' })) {
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

async function inverseList(targetId, inv, actor) {
  const out = [];
  for (const a of await store.query({ model: ref(inv.sourceModel) })) {
    if (a.lifecycle?.status !== 'retired' && a.attr?.[inv.field] === ref(targetId)
        && (!actor || await canSee(actor, a.id)))  // an actor-scoped read only sees backlinks it may open
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

const deref = async (node, actor) => {
  if (!isRef(node)) return node;
  const a = await getAtom(refId(node));
  if (actor && !await canSee(actor, a.id)) throw new Err(404, `no atom ${refId(node)}`); // can't cross into an unreadable/foreign atom
  return a;
};

async function readField(node, seg, actor) {
  if (node == null) throw new Err(404, `null before .${seg}`);
  if (Array.isArray(node)) {
    const out = [];
    for (const n of node) out.push(await readField(await deref(n, actor), seg, actor));
    return out;
  }
  if (isAtomObj(node)) {
    if (node.attr && seg in node.attr) {
      if (seg === 'secret') throw new Err(404, `no field .${seg} on ${node.id}`); // never traversable (see redact)
      // per-attribute read grant — the same redaction the whole-atom view applies,
      // so a path can't reach an attribute the actor couldn't see directly.
      if (actor && !await canRead(actor, `${refId(node.model)}.${seg}`)) throw new Err(404, `no field .${seg} on ${node.id}`);
      return node.attr[seg];
    }
    if (node.lifecycle && typeof node.lifecycle === 'object' && seg in node.lifecycle)
      return node.lifecycle[seg];
    const inv = invReg[seg];
    if (inv && inv.targetModel === refId(node.model)) return inverseList(node.id, inv, actor);
    // virtual `.tenant` edge: every atom's nearest tenant ancestor, as a ref (or
    // null at the global root). Lets rules read `actor.tenant` / `atom.tenant`
    // without a stored field. Only a fallback — a real `tenant` attr wins above.
    if (seg === 'tenant') { const t = await tenantOf(node); return t ? ref(t) : null; }
    throw new Err(404, `no field .${seg} on ${node.id}`);
  }
  if (typeof node === 'object') return node[seg];
  throw new Err(404, `cannot read .${seg} of a scalar`);
}

async function traverse(start, segs, actor) {
  if (segs.length > 16) throw new Err(400, 'path exceeds traversal budget'); // budget/cycle guard
  let node = start;
  for (const seg of segs) node = await readField(await deref(node, actor), seg, actor);
  return node; // final value left un-dereferenced (a ref stays a ref)
}

// ---------------------------------------------------------------------------
// Validation: an atom's attr against its model's fields (Zod-style)
// ---------------------------------------------------------------------------

async function validate(modelId, attr) {
  const m = await getAtom(modelId);
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
      out[key] = await validate(sub, ev); // returns a plain, validated object
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

async function findByIdentity(modelId, attr, modelAtom) {
  for (const idx of identityIndexes(modelAtom)) {
    const keyFields = idx.on;
    if (keyFields.some((f) => attr[f] === undefined)) continue;
    for (const a of await store.query({ model: ref(modelId) })) {
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

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// Secret → token resolver, memoized on storeGen. A token's API secret is stored
// only as a hash (attr.secret); the bearer presents the CLEAR secret, which we
// hash and look up. Rebuilt lazily whenever the store changes.
const _secretIdx = { gen: -1, map: new Map() };
async function tokenBySecret(clear) {
  if (_secretIdx.gen !== storeGen) {
    const map = new Map();
    for (const t of await store.query({ model: 'atom://token' }))
      if (t.attr?.secret && t.lifecycle?.status !== 'retired') map.set(t.attr.secret, t.id);
    _secretIdx.gen = storeGen; _secretIdx.map = map;
  }
  const id = _secretIdx.map.get(sha256(clear));
  return id ? getAtom(id) : null;
}

// The actor is resolved from a tracked session (cookie or `Bearer sess-…`) or a
// token's API secret (`Bearer <secret>`). A token's PUBLIC ID is never a credential
// — ids leak through createdBy, refs, and path reads, so accepting one would let
// anyone impersonate any token (e.g. the old `Bearer joey` = instant admin). An
// unauthenticated request resolves to atom://0 — the anonymous identity.
async function actorFromReq(req, cookies) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const bearer = m ? m[1] : null;
  let sid = cookies['atomic_session'];                   // browsers carry a session the kernel tracks
  if (bearer) {
    if (bearer.startsWith('sess-')) sid = bearer;        // a session id, presented as a bearer (= the cookie)
    else {                                               // otherwise it must be a token's API secret
      const t = await tokenBySecret(bearer);
      if (t && t.lifecycle?.status !== 'retired' && !await isExpired(t)) return t;
    }
  }
  if (sid && await store.has(sid)) {
    const s = await store.get(sid);
    if (s.model === 'atom://session' && s.lifecycle.status === 'active' &&
        (!s.attr.expiresAt || s.attr.expiresAt > now()) && await store.has(refId(s.attr.token))) {
      const t = await getAtom(refId(s.attr.token));
      // the session must still bind a live token (it could have been retired)
      if (t.model === 'atom://token' && t.lifecycle?.status !== 'retired')
        return { ...t, _session: sid };  // a transient copy carrying the session id — never mutate the stored atom
    }
  }
  return getAtom('0'); // atom://0 — the anonymous identity (no data grants)
}

// A session is an atom too — it binds a cookie id to the token it authenticates.
async function newSession(tokenId) {
  const id = `sess-${randomUUID()}`; // full 122-bit id — this cookie is a bearer credential
  // a session is parented into the token's own tenant, not left global. Combined
  // with the surface never serving session atoms (see getStore + the GET guard),
  // this means one tenant can never read another's live session ids (cookies).
  const parent = await tenantOf(await store.get(tokenId)) || '0';
  await seed({
    id, model: 'atom://session', manifest: `session for ${tokenId}`,
    attr: { token: ref(tokenId), createdAt: now(), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(), createdBy: ref(tokenId), parent: ref(parent) },
  });
  return id;
}

// a token's effective grants = its own grants + the grants of every role it
// references. A role atom is just a reusable bundle of grants (see canSee/role).
const _grants = new WeakMap(); // actor obj -> { gen, val }; actor objs are per-request
const grantsOf = async (actor) => {
  const hit = _grants.get(actor);
  if (hit && hit.gen === storeGen) return hit.val;
  const roleGrants = [];
  for (const r of (actor.attr?.roles || [])) {
    const role = await store.get(isRef(r) ? refId(r) : r);
    roleGrants.push(...(role?.attr?.grants || []));
  }
  const val = [...(actor.attr?.grants || []), ...roleGrants];
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
const allows = async (actor, target, op) =>
  (await grantsOf(actor)).some((x) => permits(x.mode, op) && grantMatch(x.path, target));
// model-level: may the actor do `op` on this model/index as a whole?
const canOp = async (actor, name, op) =>
  (await grantsOf(actor)).some((x) => { const s = x.path.split('.')[0]; return (s === name || s === '*' || s === '**') && permits(x.mode, op); });
// nav visibility: does the actor hold any grant touching this name?
const canTouch = async (actor, name) =>
  (await grantsOf(actor)).some((x) => { const s = x.path.split('.')[0]; return s === name || s === '*' || s === '**'; });
const canRead = async (actor, target) => allows(actor, target, 'read');
// May the actor see this atom AT ALL (vs. just some of its attributes)? Used to
// gate the universal feed and index results so they never leak the id/manifest of
// an atom the actor holds no read grant for. Per-attribute redaction happens after.
const readableAtom = async (actor, a) =>
  a.lifecycle?.status !== 'retired' && await canOp(actor, refId(a.model), 'read') && await ruleOk(actor, a, 'read');

// Attenuation: a token (or hook) may only be issued with grants that are a subset
// of the issuer's own — it can never grant more than it holds. This covers BOTH
// inline `grants` AND `roles`: a role confers its grants on every token that wears
// it, so a referenced role must be visible to the issuer and hold nothing beyond
// the issuer's own — otherwise roles would be an attenuation bypass (mint a `**`
// role, then wear it). Runs on every token/hook create and update.
async function attenuate(actor, modelId, attr) {
  if (!['token', 'hook'].includes(modelId)) return;
  const own = await grantsOf(actor);
  const within = (cg) => own.some((g) => grantMatch(g.path, cg.path) && permits(g.mode, cg.mode));
  for (const cg of (Array.isArray(attr.grants) ? attr.grants : []))
    if (!within(cg)) throw new Err(403, `cannot grant ${cg.mode} ${cg.path}: it exceeds your own grants`);
  for (const r of (Array.isArray(attr.roles) ? attr.roles : [])) {
    const role = await store.get(isRef(r) ? refId(r) : r);
    if (!role || role.model !== 'atom://role') throw new Err(400, `not a role: ${r}`);
    if (!await visible(actor, role)) throw new Err(403, `cannot wear role ${r} (out of scope)`);
    for (const cg of (role.attr.grants || []))
      if (!within(cg)) throw new Err(403, `cannot wear role ${r}: it grants ${cg.mode} ${cg.path} beyond your own`);
  }
}

// A model's rules.read/write are path-expression predicates evaluated against
// the actor and the atom. A safe evaluator — no eval: only literals, equality,
// and path reads. Anything it can't parse denies (access is never granted by error).
async function resolveSide(s, actor, atom) {
  s = s.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('atom://')) return s;
  const segs = s.split('.');
  let base = atom;
  if (segs[0] === 'actor') { base = actor; segs.shift(); }
  try { return segs.length ? await traverse(base, segs) : (base && base.id ? ref(base.id) : base); }
  catch { return undefined; }
}
async function evalRule(pred, actor, atom) {
  if (pred == null || pred === 'true' || pred === true) return true;
  if (pred === 'false' || pred === false) return false;
  const m = String(pred).match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (!m) return false;
  const l = await resolveSide(m[1], actor, atom), r = await resolveSide(m[3], actor, atom);
  return m[2] === '==' ? l === r : l !== r;
}
const ruleOk = async (actor, atom, which) =>
  evalRule((await getAtom(refId(atom.model))).attr.rules?.[which], actor, atom);

// May `actor` WRITE `atom`? Per the tree model (README: "you can write an atom
// only if it shares your tenant ancestor; a token with no tenant is a superuser"):
// a tenant user may write only atoms in its OWN tenant — never a global/root atom
// (the core substrate + shared definitions, which have no tenant ancestor) and
// never another tenant's. A tenant-less root writes anything. The model's own
// write rule is then ANDed on top. This makes "root atoms are root-only" a
// structural invariant for EVERY type, not a per-model rule.
const writable = async (actor, atom) =>
  (await tenantOf(actor) === null || await tenantOf(atom) === await tenantOf(actor)) && await ruleOk(actor, atom, 'write');

// the tenant is the parent atom: an atom's tenant is its nearest tenant ancestor
// (walk lifecycle.parent). Global atoms (the core models) have none.
const _tenant = new Map(); // id -> { gen, val }; the ancestor walk is pure given the store
async function tenantOf(atom) {
  if (!atom) return null;
  const hit = _tenant.get(atom.id);
  if (hit && hit.gen === storeGen) return hit.val;
  let cur = atom, val = null;
  for (let hops = 0; cur && hops < 8; hops++) {
    if (cur.model === 'atom://tenant') { val = cur.id; break; }
    const p = cur.lifecycle?.parent;
    if (!isRef(p) || refId(p) === cur.id) break;
    cur = await getCached(refId(p));
  }
  _tenant.set(atom.id, { gen: storeGen, val });
  return val;
}
// a global atom is visible to all; otherwise the actor must share its tenant
async function visible(actor, atom) {
  if (await isExpired(atom)) return false;    // lazy expiry: past its policy → invisible
  const at = await tenantOf(atom), ut = await tenantOf(actor);
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
async function getStore(actor) {
  let hit = _scope.get(actor);
  if (!hit || hit.gen !== storeGen) {
    // session atoms are bearer credentials, never application data: they are
    // excluded from every actor-facing read here, so no listing, index, feed,
    // ref-map, datalist, or workspace can ever surface a live cookie id.
    // tenant scoping pushed into the store: root (no tenant) sees every shard;
    // a tenant user sees only the global shard plus its own. So a read never
    // even materializes another tenant's atoms.
    const ut = await tenantOf(actor);
    const shards = ut === null ? null : ['_global', ut];
    const rows = await store.query({ shards });
    hit = { gen: storeGen, list: await asyncFilter(rows, async (a) => a.model !== 'atom://session' && await visible(actor, a)) };
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
const ATOMIC_DB = process.env.ATOMIC_DB || null; // a postgres:// URL → the Postgres driver
const shardOf = async (atom) => await tenantOf(atom) || '_global';

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
  // Every method is async — it resolves immediately over the in-RAM Map, but the
  // interface is the contract: the kernel awaits the store everywhere, so a later
  // phase can drop in an async Postgres driver without touching the kernel.
  return {
    get: async (id) => m.get(id), set: async (id, a) => m.set(id, a), has: async (id) => m.has(id),
    delete: async (id) => m.delete(id), values: async () => [...m.values()], count: async () => m.size,
    // scoped read: the rows in `shards` (null = all) of type `model` (null = any).
    async query({ shards = null, model = null } = {}) {
      const out = [];
      for (const a of m.values()) {
        if (model && a.model !== model) continue;
        if (shards && !shards.includes(await shardOf(a))) continue;
        out.push(a);
      }
      return out;
    },
    // Transactions. This driver hands out live atom references the kernel mutates in
    // place (bump), so a shallow copy would alias those mutations — transact() takes a
    // deep snapshot up front and restores it on failure. O(store) per tx, but this is
    // the in-RAM dev default; the durable drivers below use the engine's own BEGIN/COMMIT.
    async transact(fn) {
      const snap = new Map(); for (const [k, v] of m) snap.set(k, structuredClone(v));
      try { return await fn(); }
      catch (e) { m.clear(); for (const [k, v] of snap) m.set(k, v); throw e; }
    },
    async close() {},
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
  // secondary index over chosen attr fields (+ built-in createdAt/updatedAt): one
  // opaque (shard, model, field, value, id) row per indexed value. `value` has no
  // declared affinity, so a number is stored as a number and a string as a string —
  // within a field (one kind) ordering is correct, so equality, range, AND sort are
  // all index-backed. The store stays dumb: the KERNEL decides which fields to project.
  db.exec('CREATE TABLE IF NOT EXISTS idx (shard TEXT, model TEXT, field TEXT, value, id TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lookup ON idx(model, field, value, shard, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_by_id ON idx(id)');
  const cache = new Map();                                   // sql string -> prepared statement
  const prep = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s; };
  const q = {
    get:    prep('SELECT body FROM atom WHERE id = ?'),
    has:    prep('SELECT 1 FROM atom WHERE id = ?'),
    put:    prep('INSERT INTO atom(id, shard, model, body) VALUES(?, ?, ?, ?) ' +
                 'ON CONFLICT(id) DO UPDATE SET shard = excluded.shard, model = excluded.model, body = excluded.body'),
    del:    prep('DELETE FROM atom WHERE id = ?'),
    all:    prep('SELECT body FROM atom'),
    count:  prep('SELECT count(*) AS c FROM atom'),
    idxDel: prep('DELETE FROM idx WHERE id = ?'),
    idxIns: prep('INSERT INTO idx(shard, model, field, value, id) VALUES(?, ?, ?, ?, ?)'),
    idxCnt: prep('SELECT count(*) AS c FROM idx'),
  };
  // Every method is async. node:sqlite is synchronous, so each wraps an
  // immediately-resolving call — the async interface is what the kernel relies
  // on, so a later phase can swap in an async Postgres driver unchanged.
  return {
    async get(id)      { const r = q.get.get(id); return r ? parseLine(r.body) : undefined; },
    async set(id, a)   { q.put.run(id, await shardOf(a), a.model, serializeLine(a)); },
    async has(id)      { return !!q.has.get(id); },
    async delete(id)   { q.del.run(id); q.idxDel.run(id); },
    async values()     { return q.all.all().map((r) => parseLine(r.body)); },
    async count()      { return Number(q.count.get().c); },
    // replace the secondary-index rows for one atom (rows = [{field, value}]).
    async setIndex(id, shard, model, rows) {
      q.idxDel.run(id);
      for (const r of rows) q.idxIns.run(shard, model, r.field, r.value, id);
    },
    async indexCount() { return Number(q.idxCnt.get().c); },
    // an index-backed page: scoped + filtered + sorted + limited entirely in SQL, so
    // a read never materializes the model's full set. `anchorField` drives the order
    // (always an indexed field); each filter is an id-membership probe on idx. A
    // value-only cursor continues the page (ties at the boundary value are tolerated,
    // matching the existing index pagination). Returns [{ body, cursor }].
    async page({ shards, model, anchorField, anchorDesc, filters, cursor, limit }) {
      const w = ['x.model = ?', 'x.field = ?'], p = [model, anchorField];
      if (shards) { w.push(`x.shard IN (${shards.map(() => '?').join(', ')})`); p.push(...shards); }
      for (const f of filters) {
        const sub = ['model = ?', 'field = ?'], sp = [model, f.field];
        if (shards) { sub.push(`shard IN (${shards.map(() => '?').join(', ')})`); sp.push(...shards); }
        if (f.op === '=' && Array.isArray(f.val)) { sub.push(`value IN (${f.val.map(() => '?').join(', ')})`); sp.push(...f.val); }
        else { sub.push(`value ${f.op} ?`); sp.push(f.val); }
        w.push(`x.id IN (SELECT id FROM idx WHERE ${sub.join(' AND ')})`); p.push(...sp);
      }
      if (cursor != null) { w.push(anchorDesc ? 'x.value < ?' : 'x.value > ?'); p.push(cursor); }
      const dir = anchorDesc ? 'DESC' : 'ASC';
      const sql = `SELECT a.body AS body, x.value AS av FROM idx x JOIN atom a ON a.id = x.id`
        + ` WHERE ${w.join(' AND ')} ORDER BY x.value ${dir}, x.id ${dir} LIMIT ?`;
      p.push(limit);
      return prep(sql).all(...p).map((r) => ({ body: parseLine(r.body), cursor: r.av }));
    },
    // scoped read: pushes the tenant (shard) and type (model) filters into SQL so a
    // read hits the atom_by_shard / atom_by_model indexes and never materializes
    // atoms outside its scope — this is what holds up at billions of atoms/tenant.
    async query({ shards = null, model = null } = {}) {
      const where = [], params = [];
      if (shards) { where.push(`shard IN (${shards.map(() => '?').join(', ')})`); params.push(...shards); }
      if (model)  { where.push('model = ?'); params.push(model); }
      const sql = 'SELECT body FROM atom' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
      return prep(sql).all(...params).map((r) => parseLine(r.body));
    },
    // Transactions: SQLite's own, on the single writer connection. ROLLBACK reverts
    // every change as one unit; durable on COMMIT (WAL + synchronous=NORMAL fsyncs at
    // the checkpoint). (node:sqlite is synchronous, so a tx does not truly overlap I/O.)
    async transact(fn) {
      db.exec('BEGIN');
      try { const r = await fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async close()      { db.close(); },
  };
}

// Postgres (ATOMIC_DB set): the scale-out durable store. Same shape as the SQLite
// driver — atom(id, shard, model, body) + a generic idx — but with real concurrency
// (MVCC, many writers), connection pooling, and managed backups/replication/HA. The
// body is TEXT, so ATOMIC_KEY sealing works unchanged; the idx `value` is JSONB, which
// orders numbers numerically and strings lexically within a field — exactly like
// SQLite's no-affinity column — so equality, range, and sort stay index-backed.
// A transaction pins one pooled connection and routes its OWN operations to it via
// AsyncLocalStorage: a concurrent request that interleaves while the tx awaits sees an
// empty ALS, uses the pool (MVCC-isolated), and can never land on the tx's connection.
async function pgStore() {
  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ connectionString: ATOMIC_DB, max: 12 });
  const als = new AsyncLocalStorage();
  const q = (sql, params) => (als.getStore() || pool).query(sql, params);
  await q('CREATE TABLE IF NOT EXISTS atom (id text PRIMARY KEY, shard text NOT NULL, model text NOT NULL, body text NOT NULL)');
  await q('CREATE INDEX IF NOT EXISTS atom_by_shard ON atom(shard)');
  await q('CREATE INDEX IF NOT EXISTS atom_by_model ON atom(model)');
  await q('CREATE TABLE IF NOT EXISTS idx (shard text, model text, field text, value jsonb, id text)');
  await q('CREATE INDEX IF NOT EXISTS idx_lookup ON idx(model, field, value, shard, id)');
  await q('CREATE INDEX IF NOT EXISTS idx_by_id ON idx(id)');
  return {
    async get(id)    { const r = await q('SELECT body FROM atom WHERE id = $1', [id]); return r.rows[0] ? parseLine(r.rows[0].body) : undefined; },
    async has(id)    { const r = await q('SELECT 1 FROM atom WHERE id = $1', [id]); return r.rowCount > 0; },
    async set(id, a) { await q('INSERT INTO atom(id, shard, model, body) VALUES($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET shard = EXCLUDED.shard, model = EXCLUDED.model, body = EXCLUDED.body', [id, await shardOf(a), a.model, serializeLine(a)]); },
    async delete(id) { await q('DELETE FROM atom WHERE id = $1', [id]); await q('DELETE FROM idx WHERE id = $1', [id]); },
    async values()   { const r = await q('SELECT body FROM atom'); return r.rows.map((x) => parseLine(x.body)); },
    async count()    { const r = await q('SELECT count(*)::int AS c FROM atom'); return r.rows[0].c; },
    async setIndex(id, shard, model, rows) {
      await q('DELETE FROM idx WHERE id = $1', [id]);
      for (const r of rows) await q('INSERT INTO idx(shard, model, field, value, id) VALUES($1, $2, $3, $4::jsonb, $5)', [shard, model, r.field, JSON.stringify(r.value), id]);
    },
    async indexCount() { const r = await q('SELECT count(*)::int AS c FROM idx'); return r.rows[0].c; },
    async page({ shards, model, anchorField, anchorDesc, filters, cursor, limit }) {
      const p = []; const ph = (v) => { p.push(v); return '$' + p.length; };
      const w = [`x.model = ${ph(model)}`, `x.field = ${ph(anchorField)}`];
      if (shards) w.push(`x.shard = ANY(${ph(shards)})`);
      for (const f of filters) {
        const sub = [`model = ${ph(model)}`, `field = ${ph(f.field)}`];
        if (shards) sub.push(`shard = ANY(${ph(shards)})`);
        if (f.op === '=' && Array.isArray(f.val)) sub.push(`value IN (${f.val.map((v) => ph(JSON.stringify(v)) + '::jsonb').join(', ')})`);
        else sub.push(`value ${f.op} ${ph(JSON.stringify(f.val))}::jsonb`);
        w.push(`x.id IN (SELECT id FROM idx WHERE ${sub.join(' AND ')})`);
      }
      if (cursor != null) w.push(`x.value ${anchorDesc ? '<' : '>'} ${ph(JSON.stringify(cursor))}::jsonb`);
      const dir = anchorDesc ? 'DESC' : 'ASC';
      const r = await q(`SELECT a.body AS body, x.value AS av FROM idx x JOIN atom a ON a.id = x.id WHERE ${w.join(' AND ')} ORDER BY x.value ${dir}, x.id ${dir} LIMIT ${ph(limit)}`, p);
      return r.rows.map((row) => ({ body: parseLine(row.body), cursor: row.av }));
    },
    async query({ shards = null, model = null } = {}) {
      const p = []; const ph = (v) => { p.push(v); return '$' + p.length; };
      const w = [];
      if (shards) w.push(`shard = ANY(${ph(shards)})`);
      if (model)  w.push(`model = ${ph(model)}`);
      const r = await q('SELECT body FROM atom' + (w.length ? ' WHERE ' + w.join(' AND ') : ''), p);
      return r.rows.map((x) => parseLine(x.body));
    },
    async transact(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await als.run(client, fn);             // tx ops route to this client; others use the pool
        await client.query('COMMIT');
        return r;
      } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
      finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
store = ATOMIC_DB ? await pgStore() : ROOT ? sqliteStore() : memStore();
// secondary-index projection for one atom: built-in createdAt/updatedAt plus every
// attr field the model declares `filterable`/`sortable`. Scalars only; a retired
// atom projects nothing (so it leaves the index). Under ATOMIC_KEY a value is stored
// as a keyed hash (blind index) — equality survives, order/range do not.
const blind = (v) => sha256(KEY.toString('hex') + '\0' + String(v));
async function indexRows(atom) {
  if (atom.lifecycle?.status === 'retired') return [];
  const rows = [];
  const lc = atom.lifecycle || {};
  for (const f of ['createdAt', 'updatedAt']) if (lc[f] != null) rows.push({ field: f, value: KEY ? blind(lc[f]) : lc[f] });
  let model; try { model = await store.get(refId(atom.model)); } catch { model = null; }
  for (const [f, def] of Object.entries(model?.attr?.fields || {})) {
    if (!def || typeof def !== 'object' || !(def.filterable || def.sortable)) continue;
    const v = atom.attr?.[f];
    if (v == null || typeof v === 'object') continue;            // scalars only
    rows.push({ field: f, value: KEY ? blind(v) : v });
  }
  return rows;
}
// durable write-back; also refreshes the atom's secondary-index rows. Bumps the gen.
async function persist(atom) { await store.set(atom.id, atom); if (store.setIndex) await store.setIndex(atom.id, await shardOf(atom), atom.model, await indexRows(atom)); if (CONTROL_MODELS.has(atom.model)) _ctl.set(atom.id, atom); storeGen++; }

// --- Transactions. A batch of mutations that commits all-or-nothing. Each store
// driver implements transact(fn): runs fn inside one transaction (SQLite/Postgres
// BEGIN..COMMIT; a deep snapshot for the in-RAM driver), rolling back on any throw.
// On rollback storeGen is bumped so every gen-keyed read memo rebuilds against the
// reverted state. Nested tx() calls join the enclosing one (a cascading delete
// composes without opening a second transaction). Top-level transactions are
// serialized by an async lock so _txDepth and the gen counter stay coherent across
// the event loop; the Postgres driver additionally routes each tx's own reads/writes
// to its pinned connection (AsyncLocalStorage), so a concurrent request that
// interleaves while a tx awaits is isolated on a separate pooled connection.
let _txDepth = 0;
let _txLock = Promise.resolve();
async function tx(fn) {
  if (_txDepth > 0) return fn();                 // already inside a transaction — join it
  const prev = _txLock; let release;             // serialize top-level transactions
  _txLock = new Promise((r) => { release = r; });
  await prev;
  _txDepth++;
  try {
    return await store.transact(async () => {
      try { return await fn(); }
      catch (e) { storeGen++; _ctl.clear(); throw e; } // reverted state invalidates the read memos + the control cache
    });
  } finally { _txDepth--; release(); }
}

// One-time migration: fold any legacy per-tenant NDJSON shards (the previous
// on-disk format) into atoms.db, last-write-wins by id, then set them aside as
// .migrated so they are never re-read. A fresh store has none and this is a no-op.
async function migrateNdjson() {
  if (!ROOT || !fs.existsSync(ROOT)) return;
  let n = 0;
  for (const shard of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, shard, 'log.ndjson');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n'))
      if (line.trim()) { const a = parseLine(line); await store.set(a.id, a); n++; }
    fs.renameSync(f, f + '.migrated');
  }
  if (n) console.error(`migrated ${n} NDJSON log lines into atoms.db`);
}
// Durable data present? (SQLite: rows in atoms.db, after folding any legacy NDJSON.)
async function loadAll() {
  if (!ROOT) return false;
  if (await store.count() === 0) await migrateNdjson();
  return await store.count() > 0;
}

async function redact(actor, atom) {
  if (atom.id === '0') return atom; // the public root atom — the address everyone sees
  const modelId = refId(atom.model);
  const attr = {};
  for (const [k, v] of Object.entries(atom.attr || {})) {
    if (k === 'secret') continue;                  // a token's API secret hash is never served, to anyone
    if (await canRead(actor, `${modelId}.${k}`)) attr[k] = v;
  }
  return { ...atom, attr };
}

// ---------------------------------------------------------------------------
// Write path: create / update / delete  (every write appends to the ledger)
// ---------------------------------------------------------------------------

async function logIt(atomId, op, actorId, changes, sessionId) {
  const id = `log-${++logSeq}`;
  const subj = await store.get(atomId);
  await seed({
    id, model: 'atom://log', manifest: `${op} ${atomId}`,
    attr: { atom: ref(atomId), op, actor: ref(actorId),
      ...(sessionId ? { session: ref(sessionId) } : {}), at: now(), changes },
    lifecycle: { status: 'active', version: 1, modelVersion: 1, createdAt: now(),
      createdBy: ref(actorId), parent: ref(subj ? (await tenantOf(subj) || '0') : '0') },
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
async function bump(atom, by) {
  atom.lifecycle.version++;
  atom.lifecycle.updatedAt = now();
  atom.lifecycle.updatedBy = ref(by);
  await persist(atom);
}

// a writer may point an atom's lifecycle.expiration at any policy they can see
// (their own tenant's, or a global one); absent → the supplied fallback. This is
// how a user automates retention of their own data without operator help.
async function resolveExpiration(body, actor, fallback) {
  if (body.expiration === undefined) return fallback;
  if (!isRef(body.expiration)) throw new Err(400, 'expiration must be a policy reference');
  const pol = await getAtom(refId(body.expiration));
  if (pol.model !== 'atom://policy') throw new Err(400, `${body.expiration} is not a policy`);
  if (!await visible(actor, pol)) throw new Err(403, `cannot use policy ${body.expiration}`);
  return body.expiration;
}

async function create(modelId, body, actor) {
  const modelAtom = await getAtom(modelId);
  const fields = Object.keys(body.attr || {});
  // a baseline create grant on the model is required even for an all-default/empty
  // body — otherwise `fields.every(...)` is vacuously true and a grantless actor
  // could create atoms of any all-optional model. Then each named field is checked.
  let fieldsOk = true;
  for (const f of fields) if (!await allows(actor, `${modelId}.${f}`, 'create')) { fieldsOk = false; break; }
  if (!await canOp(actor, modelId, 'create') || !fieldsOk)
    throw new Err(403, `${actor.id} cannot create ${modelId}`);

  // POST creates. An explicit id must be a safe slug — it becomes a URL path and is
  // rendered into HTML/links, so reject anything with HTML/URL metacharacters or
  // whitespace (allow letters, digits, and . _ - @ : so dotted index ids and
  // `model@1-2` migration ids still work). An id that already exists is a conflict.
  if (body.id && !/^[A-Za-z0-9._@:-]+$/.test(String(body.id)))
    throw new Err(400, `invalid id "${body.id}" — use letters, digits, and . _ - @ :`);
  if (body.id && await store.has(body.id))
    throw new Err(409, `atom ${body.id} exists — PATCH /${body.id} to update, PUT /${body.id} to replace`);

  const attr = await validate(modelId, body.attr || {});
  await attenuate(actor, modelId, attr);

  // identity dedup -> merge instead of duplicate
  const existing = await findByIdentity(modelId, attr, modelAtom);
  if (existing) {
    const before = { ...existing.attr };
    const merge = modelAtom.attr.behavior?.merge || 'merge';
    existing.attr = merge === 'replace' ? attr : { ...existing.attr, ...attr };
    await bump(existing, actor.id);
    await logIt(existing.id, 'merge', actor.id, changeset(before, existing.attr), actor._session);
    return existing;
  }

  // by default an atom is born into the creator's tenant; an authorized caller
  // may place it under a chosen parent (e.g. root provisioning a new tenant)
  let parentId = await tenantOf(actor) || '0';
  if (body.parent && isRef(body.parent)) {
    const target = await getAtom(refId(body.parent));
    // a non-superuser may only place an atom within its OWN tenant — not into
    // another tenant, and not into the global scope (parent atom://0, which is
    // world-visible). Only a tenant-less superuser (root) provisions across or
    // above tenants. (visible() allows global, so check tenant equality here.)
    if (await tenantOf(actor) !== null && await tenantOf(target) !== await tenantOf(actor))
      throw new Err(403, `${actor.id} cannot place into ${body.parent}`);
    parentId = refId(body.parent);
  }
  // a generated id must be unique — never silently clobber an existing atom.
  // (An explicit body.id collision is already a 409 above.)
  let id = body.id;
  if (!id) do { id = randomUUID().slice(0, 8); } while (await store.has(id));
  const atom = {
    id, model: ref(modelId),
    manifest: body.manifest || '',
    attr,
    lifecycle: {
      status: 'active', version: 1,
      modelVersion: modelAtom.attr.version || 1,
      createdAt: now(), updatedAt: now(), createdBy: ref(actor.id), parent: ref(parentId),
      expiration: await resolveExpiration(body, actor, ref('policy-default')), // a chosen policy, else the default
      ...(body.hooks ? { hooks: body.hooks } : {}), // hooks registered on this atom
    },
  };
  if (!await writable(actor, atom))
    throw new Err(403, `cannot create ${modelId} (tenant scope or write rule)`);
  // a token gets a high-entropy API secret on creation. We persist only its hash
  // (attr.secret — never served), and surface the CLEAR value ONCE via a non-
  // enumerable property, so it is neither stored nor readable again.
  let mintedSecret = null;
  if (modelId === 'token') {
    mintedSecret = 'atk_' + randomBytes(32).toString('hex');
    atom.attr.secret = sha256(mintedSecret);
  }
  await seed(atom);
  if (mintedSecret) Object.defineProperty(atom, '_secret', { value: mintedSecret, enumerable: false });
  if (modelId === 'model') {
    await buildInverse(); // a new model may declare inverse edges
    // creator-owns: defining a type mints full ownership of it for a tenant user,
    // so they can immediately CRUD its instances. Attenuation can't self-grant a
    // brand-new type, and creating it IS the legitimate mint — the type is empty,
    // so this grants nothing over pre-existing data. Root already holds **.
    if (await tenantOf(actor) !== null) {
      const tok = await store.get(actor.id);
      if (tok?.model === 'atom://token') {
        const grants = tok.attr.grants || (tok.attr.grants = []);
        if (!grants.some((x) => x.path === `${id}.*`)) { grants.push({ path: `${id}.*`, mode: 'all' }); await bump(tok, actor.id); }
      }
    }
  }
  await logIt(id, 'create', actor.id, changeset({}, attr), actor._session);
  return atom;
}

// PATCH merges body.attr into the current attr; PUT replaces it wholesale. Both
// keep the atom's id and provenance (createdAt/createdBy), bump the version, and
// append to the ledger — the only differences are the next-attr expression and
// the log op label, so they share one body.
async function writeAtom(id, body, actor, ifMatch, mode) {
  const atom = await getAtom(id);
  if (!await visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  const modelId = refId(atom.model);
  const fields = Object.keys(body.attr || {});
  for (const f of fields) if (!await allows(actor, `${modelId}.${f}`, 'update'))
    throw new Err(403, `${actor.id} cannot update ${modelId}`);
  if (ifMatch != null && Number(ifMatch) !== atom.lifecycle.version)
    throw new Err(409, `version conflict: have ${atom.lifecycle.version}, sent ${ifMatch}`);
  const before = { ...atom.attr };
  atom.attr = await validate(modelId, mode === 'replace' ? (body.attr || {}) : { ...atom.attr, ...body.attr });
  if (modelId === 'token' && before.secret) atom.attr.secret = before.secret; // secret is kernel-owned: immutable, never user-set
  await attenuate(actor, modelId, atom.attr);
  if (!await writable(actor, atom)) throw new Err(403, `cannot ${mode} ${modelId} (tenant scope or write rule)`);
  if (mode === 'update' && body.hooks) atom.lifecycle.hooks = body.hooks; // (re)register lifecycle hooks
  if (body.expiration !== undefined) atom.lifecycle.expiration = await resolveExpiration(body, actor, atom.lifecycle.expiration); // re-point retention policy
  await bump(atom, actor.id);
  await logIt(id, mode, actor.id, changeset(before, atom.attr), actor._session);
  return atom;
}
const update  = (id, body, actor, ifMatch) => writeAtom(id, body, actor, ifMatch, 'update');
const replace = (id, body, actor, ifMatch) => writeAtom(id, body, actor, ifMatch, 'replace');

// the create response for a token strips the stored secret HASH and surfaces the
// CLEAR API secret exactly once (it is never recoverable again — store it now).
function tokenCreateView(a) {
  if (!a || a.model !== 'atom://token') return a;
  const { secret, ...attr } = a.attr || {};
  return { ...a, attr, ...(a._secret ? { secret: a._secret } : {}) };
}

// Hooks (the Logic primitive). A hook is an atom { run: <script>, grants: [...] }
// registered in some atom's lifecycle.hooks (see runHooks). After a write, each
// registered hook runs its script from ./scripts/<run>.mjs and may patch the atom.
// a hook writes under ITS OWN grants — not the caller's. So a caller who can
// only submit an advocate can still trigger a hook that writes a field they can't.
async function patchAtom(atom, fields, hook) {
  const modelId = refId(atom.model);
  for (const f of Object.keys(fields))
    if (!await allows(hook, `${modelId}.${f}`, 'write'))
      throw new Err(403, `hook ${hook.id} is not granted write on ${modelId}.${f}`);
  const before = { ...atom.attr };
  atom.attr = { ...atom.attr, ...fields };
  await bump(atom, hook.id);
  await logIt(atom.id, 'hook', hook.id, changeset(before, atom.attr));
}
// a hook may upsert a related atom (e.g. the census district it links to) under
// its own grants, into the subject's tenant. Returns the ref to link.
async function hookUpsert(hook, subject, modelId, id, attr) {
  if (await store.has(id)) return ref(id);
  for (const f of Object.keys(attr))
    if (!await allows(hook, `${modelId}.${f}`, 'create'))
      throw new Err(403, `hook ${hook.id} is not granted create on ${modelId}.${f}`);
  await seed({
    id, model: ref(modelId), manifest: id, attr: await validate(modelId, attr),
    lifecycle: { status: 'active', version: 1, modelVersion: (await getAtom(modelId)).attr.version || 1,
      createdAt: now(), createdBy: ref(hook.id), parent: ref(await tenantOf(subject) || '0') },
  });
  if (modelId === 'model') await buildInverse();
  await logIt(id, 'create', hook.id, changeset({}, attr));
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
  try { sources.push((await getAtom(refId(atom.model))).lifecycle?.hooks); } catch { /* model gone */ }
  const refs = [];
  for (const hs of sources) for (const r of [].concat(hs?.[event] || [])) if (!refs.includes(r)) refs.push(r);
  for (const hr of refs) {
    const h = await store.get(isRef(hr) ? refId(hr) : hr);
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

// Referential integrity. The atoms that point AT `targetId` through a DECLARED
// inverse edge (so the ledger's atom/actor refs — which declare no inverse — are
// never treated as edges). Each ref field carries an `onDelete` policy. System view
// (every shard): `restrict` must notice a cross-tenant referrer the deleter can't
// itself touch. Returns { src, field, mode } per live referrer.
async function inboundRefs(targetId, targetModel) {
  const out = [];
  for (const inv of Object.values(invReg)) {
    if (inv.targetModel !== targetModel) continue;
    const def = (await getAtom(inv.sourceModel)).attr.fields?.[inv.field] || {};
    const mode = def.onDelete || 'restrict';                 // default: refuse to dangle
    for (const a of await store.query({ model: ref(inv.sourceModel) }))
      if (a.lifecycle?.status !== 'retired' && a.attr?.[inv.field] === ref(targetId))
        out.push({ src: a, field: inv.field, mode });
  }
  return out;
}

// retire one atom, honoring every inbound edge's onDelete first — restrict refuses,
// null clears the referring cell, cascade retires the referrer too — all inside one
// transaction, so a base can never end up pointing at a ghost (and a half-applied
// cascade can't corrupt it). `seen` guards cycles in a cascade.
async function retireWithRefs(atom, actor, seen) {
  if (seen.has(atom.id)) return atom;
  seen.add(atom.id);
  const model = refId(atom.model);
  for (const { src, field, mode } of await inboundRefs(atom.id, model)) {
    const srcModel = refId(src.model);
    if (mode === 'restrict')
      throw new Err(409, `cannot delete ${atom.id}: ${src.id}.${field} still references it (onDelete: restrict)`);
    if (mode === 'null') {
      if (!await writable(actor, src) || !await allows(actor, `${srcModel}.${field}`, 'update'))
        throw new Err(409, `cannot delete ${atom.id}: referrer ${src.id} is outside your write scope (onDelete: null)`);
      const before = { ...src.attr };
      const next = { ...src.attr }; delete next[field];
      src.attr = await validate(srcModel, next);             // a required ref can't be nulled — validate rejects it
      await bump(src, actor.id);
      await logIt(src.id, 'update', actor.id, changeset(before, src.attr), actor._session);
    } else if (mode === 'cascade') {
      if (!await writable(actor, src) || !await canOp(actor, srcModel, 'delete'))
        throw new Err(409, `cannot delete ${atom.id}: referrer ${src.id} is outside your delete scope (onDelete: cascade)`);
      await retireWithRefs(src, actor, seen);
    }
  }
  atom.lifecycle.status = 'retired';
  await bump(atom, actor.id);
  await logIt(atom.id, 'delete', actor.id, [{ path: 'status', from: 'active', to: 'retired' }], actor._session);
  return atom;
}

async function retire(id, actor) {
  const atom = await getAtom(id);
  if (!await visible(actor, atom)) throw new Err(404, `no atom ${id}`);
  if (!await canOp(actor, refId(atom.model), 'delete'))
    throw new Err(403, `${actor.id} cannot delete ${refId(atom.model)}`);
  if (!await writable(actor, atom)) throw new Err(403, `cannot delete ${refId(atom.model)} (tenant scope or write rule)`);
  return tx(() => retireWithRefs(atom, actor, new Set()));    // all-or-nothing across the cascade
}

// Provision a base: one tenant + one open-login token scoped to it, in a single
// transaction — the "one base = one tenant, one URL" bow on top of the parts that
// already exist (structural tenancy + open-login). The token's id is the SHARE
// credential: its /auth/open URL one-clicks anyone into the base as a full session
// confined to that tenant. (That's the INTENDED public mechanism for open-login —
// distinct from the old bearer-id hole, which is why bearers are per-token secrets.)
async function provisionBase(name, actor) {
  if (await tenantOf(actor) !== null) throw new Err(403, 'only a superuser may provision a base');
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'base';
  return tx(async () => {
    let tid; do { tid = `${slug}-${randomUUID().slice(0, 6)}`; } while (await store.has(tid));
    const tenant = await create('tenant', { id: tid, attr: { name: String(name || 'New Base') } }, actor);
    const token = await create('token', { parent: ref(tenant.id), attr: { login: 'open', grants: [{ path: '**', mode: 'all' }] } }, actor);
    return { tenant, token };
  });
}

// ---------------------------------------------------------------------------
// Read path: atoms, model tables, ad-hoc queries, stored indexes
// ---------------------------------------------------------------------------

function parseQuery(search) {
  const filters = []; let sort = null, as = null, limit = null, cursor = null;
  for (const raw of search.replace(/^\?/, '').split('&').filter(Boolean)) {
    // decode the whole part FIRST, so URL-encoded comparison operators survive: the
    // WHATWG URL parser percent-encodes `>`/`<` (→ %3E/%3C), and matching the operator
    // on the encoded text would misread `n>=25` as field `n>` with op `=`.
    let part; try { part = decodeURIComponent(raw); } catch { part = raw; }
    const m = part.match(/^([^<>=]+)(>=|<=|>|<|=)(.*)$/);
    if (!m) continue;
    const [, k, op, v] = m;
    if (k === 'sort')   { sort = v; continue; }
    if (k === 'as')     { as = v; continue; }
    if (k === 'limit')  { limit = Number(v) || null; continue; }
    if (k === 'cursor') { cursor = v; continue; }
    filters.push({ field: k, op, val: v });
  }
  return { filters, sort, as, limit, cursor };
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
async function isExpired(atom) {
  const exp = atom?.lifecycle?.expiration;
  if (!exp) return false;
  const pol = await getCached(isRef(exp) ? refId(exp) : exp);
  const conds = pol?.attr?.conditions;
  if (!Array.isArray(conds) || !conds.length) return false;   // no conditions → never
  for (const c of conds)
    if (!evalCondition(atom, await getCached(isRef(c) ? refId(c) : c))) return false;
  return true;
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
async function migrationsByModel() {                    // modelId -> migrations, ordered by `from`
  if (_migs.gen === storeGen) return _migs.byModel;
  const byModel = new Map();
  for (const m of await store.query({ model: 'atom://migration' })) {
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
  const model = await store.get(refId(atom.model));
  if (!model || model.model !== 'atom://model') return atom;
  const target = model.attr.version || 1;
  let v = atom.lifecycle.modelVersion || 1;
  if (v >= target) return atom;
  const chain = (await migrationsByModel()).get(refId(atom.model)) || [];
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
  await persist(atom);
  await logIt(atom.id, 'migrate', '0', changeset(before, attr));
  return atom;
}

// sweep every atom of one model forward (a model write or new migration triggers this)
async function sweepModel(modelId) {
  if (!(await migrationsByModel()).get(modelId)?.length) return;
  for (const a of await store.query({ model: ref(modelId) })) await bringForward(a);
}
// sweep every model that has migrations — the boot "background job", run to completion
async function sweepAll() { for (const modelId of (await migrationsByModel()).keys()) await sweepModel(modelId); }

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

// Is this model field index-backed? Built-in createdAt/updatedAt, or a field the
// model declares `filterable`/`sortable`.
async function indexedField(modelId, field) {
  if (field === 'createdAt' || field === 'updatedAt') return true;
  let m; try { m = await store.get(modelId); } catch { return false; }
  const def = m?.attr?.fields?.[field];
  return !!(def && typeof def === 'object' && (def.filterable || def.sortable));
}
const numericField = async (modelId, field) => {
  let m; try { m = await store.get(modelId); } catch { return false; }
  const def = m?.attr?.fields?.[field];
  return !!(def && (def.kind === 'number' || def.kind === 'integer'));
};

// Index-backed read: scope + filters + sort + limit pushed entirely into SQL, so a
// read never materializes the model's full set — the lever for 100M-row models.
// Returns the page of redacted atoms, or null when the query isn't index-eligible,
// in which case the caller scans (the correctness oracle). Eligible = the store
// supports paging, the sort + every filter field is indexed, and (under encryption,
// where values are blind-hashed) the query is equality-only.
async function indexedRead(modelId, { filters = [], sort = null, limit = null, cursor = null }, actor) {
  if (!store.page) return null;                                  // memStore → scan
  const sortField = sort ? sort.replace(/^-/, '') : null;
  if (sortField && !await indexedField(modelId, sortField)) return null;
  for (const f of filters) if (f.field === 'q' || !await indexedField(modelId, f.field)) return null;
  if (KEY && (sortField || filters.some((f) => f.op !== '='))) return null;   // blind index: equality only
  const ut = await tenantOf(actor);
  const shards = ut === null ? null : ['_global', ut];
  const anchorField = sortField || 'createdAt';
  const anchorDesc = sort ? sort.startsWith('-') : true;          // default: newest first
  const cast = async (field, s) => KEY ? blind(s) : (await numericField(modelId, field) ? Number(s) : s);
  const typed = [];
  for (const f of filters) {
    if (f.op === '=' && String(f.val).includes(',')) {
      const vals = [];
      for (const s of String(f.val).split(',')) vals.push(await cast(f.field, s));
      typed.push({ field: f.field, op: f.op, val: vals });
    } else typed.push({ field: f.field, op: f.op, val: await cast(f.field, f.val) });
  }
  const want = Math.min(limit || 500, 1000);
  // over-fetch a margin so per-actor read rules (which the index can't apply) can
  // drop rows without under-filling the page; then gate exactly like the scan path.
  const page = await store.page({ shards, model: ref(modelId), anchorField, anchorDesc, filters: typed,
    cursor: cursor == null ? null : await cast(anchorField, cursor), limit: want * 3 + 10 });
  const out = [];
  for (const { body } of page) {
    if (out.length >= want) break;
    if (body.model === 'atom://session' || !await visible(actor, body) || !await readableAtom(actor, body)) continue;
    out.push(await redact(actor, body));
  }
  return out;
}

async function listModel(modelId, q, actor) {
  if (!await canOp(actor, modelId, 'read')) return []; // no read grant -> no listing
  const idx = await indexedRead(modelId, q, actor);
  if (idx) return idx;                            // index-backed page (never materializes the full set)
  // fallback scan — an unindexed filter/sort field, root scope, or memStore. model +
  // tenant scope are still pushed into the store (atom_by_model / atom_by_shard).
  const ut = await tenantOf(actor);
  const shards = ut === null ? null : ['_global', ut];
  const rows = await store.query({ shards, model: ref(modelId) });
  let atoms = await asyncFilter(rows,
    async (a) => a.lifecycle?.status !== 'retired' && await visible(actor, a) && await ruleOk(actor, a, 'read'));
  for (const f of q.filters) {
    if (f.field === 'q') { // full-text over manifest + attr
      const term = f.val.toLowerCase();
      atoms = atoms.filter((a) => JSON.stringify([a.manifest, a.attr]).toLowerCase().includes(term));
    } else atoms = atoms.filter((a) => passes(a, f));
  }
  atoms = sortBy(atoms, q.sort);
  const out = [];
  for (const a of atoms) out.push(await redact(actor, a));
  return out;
}

async function runIndex(indexAtom, search, actor) {
  const over = refId(indexAtom.attr.over);
  const all = over === 'atom';                 // pseudo-model atom://atom = every atom
  const params = new URLSearchParams(search);
  const match = indexAtom.attr.match || {};
  const sorts = indexAtom.attr.sort || [];
  const pg = indexAtom.attr.page;
  // Fast path: a single-model index whose match is simple equality and whose sort is
  // a single indexed field maps straight onto the secondary index — pushed into SQL,
  // never materializing the model's set. atom://atom (cross-model) always scans.
  if (!all) {
    const filters = []; let eligible = true;
    for (const [field, cond] of Object.entries(match)) {
      if (typeof cond === 'string' && cond.startsWith('params.')) {
        const v = params.get(cond.slice('params.'.length));
        if (v == null) { eligible = false; break; }
        filters.push({ field, op: '=', val: v });
      } else if (cond && typeof cond === 'object' && Array.isArray(cond.in)) {
        filters.push({ field, op: '=', val: cond.in.join(',') });
      } else filters.push({ field, op: '=', val: String(cond) });
    }
    const sort = sorts.length === 1 ? (() => { const [f, d] = Object.entries(sorts[0])[0]; return d === 'desc' ? `-${f}` : f; })() : null;
    const sortField = sort ? sort.replace(/^-/, '') : null;
    if (eligible && sorts.length <= 1 && (!pg || pg.cursor === sortField)) {
      const idx = await indexedRead(over, { filters, sort,
        limit: Number(params.get('limit')) || pg?.limit || (pg ? 25 : null),
        cursor: pg ? params.get('before') : null }, actor);
      if (idx) return idx;
    }
  }
  // scope the scan to the index's model AND the actor's shards — the same
  // index-backed lever listModel uses — instead of materializing every atom in
  // scope just to drop all but one model. atom://atom legitimately spans every
  // model, so it still reads the full in-scope set (sessions excluded by getStore).
  const ut = await tenantOf(actor);
  const shards = ut === null ? null : ['_global', ut];
  const base = all
    ? (await getStore(actor)).all().filter((a) => a.model !== 'atom://log')
    : await asyncFilter(await store.query({ shards, model: ref(over) }), async (a) => a.model !== 'atom://session' && await visible(actor, a));
  let atoms = await asyncFilter(base, (a) => readableAtom(actor, a));
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
  for (const s of sorts) {
    const [field, dir] = Object.entries(s)[0];
    atoms = sortBy(atoms, dir === 'desc' ? `-${field}` : field);
  }
  if (pg) {                                   // paginate by a date cursor + limit
    const before = params.get('before');
    if (before) atoms = atoms.filter((a) => String(fieldVal(a, pg.cursor)) < before);
    atoms = atoms.slice(0, Number(params.get('limit')) || pg.limit || 25);
  }
  const out = [];
  for (const a of atoms) out.push(await redact(actor, a));
  return out;
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
async function canSee(actor, id) {
  const a = await store.get(id);
  if (!a || a.lifecycle?.status === 'retired') return false;
  return await visible(actor, a) && await canOp(actor, refId(a.model), 'read') && await ruleOk(actor, a, 'read');
}
const link = async (actor, id) => await canSee(actor, id) ? `<a href="/${esc(id)}">atom://${esc(id)}</a>` : `atom://${esc(id)}`;

const atomValue = async (v, actor) => {
  if (v == null) return '';
  if (isRef(v)) return link(actor, refId(v));
  if (Array.isArray(v)) {
    const sep = v.every((x) => typeof x !== 'object' || isRef(x)) ? ', ' : '';
    const parts = [];
    for (const x of v) parts.push(await atomValue(x, actor));
    return parts.join(sep);
  }
  if (typeof v === 'object') return renderFields(v, actor); // an atom inside an atom
  return esc(v);
};

// render an atom's fields (a map) as the key/value atom table
async function renderFields(map, actor) {
  const cells = [];
  for (const [k, v] of Object.entries(map)) {
    const cell = (k === 'id' && typeof v === 'string' && !isRef(v)) ? await link(actor, v) : await atomValue(v, actor);
    cells.push(`<tr><td>${esc(k)}</td><td>${cell}</td></tr>`);
  }
  return `<figure><table><thead><tr><th>field</th><th>value</th></tr></thead><tbody>${cells.join('')}</tbody></table></figure>`;
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
async function csvColumns(modelAtom, prefix = '', depth = 0) {
  const cols = [];
  for (const [k, def] of Object.entries(modelAtom.attr.fields || {})) {
    const sub = embedOf(def);
    if (sub && depth < 6) cols.push(...await csvColumns(await getAtom(sub), `${prefix}${k}.`, depth + 1));
    else cols.push(prefix + k);
  }
  return cols;
}
const dotGet = (obj, parts) => parts.reduce((o, p) => (o == null ? undefined : o[p]), obj);
// header-only template: the shape to fill in for import
const templateCsv = async (modelAtom) => csvRow(['id', 'manifest', ...await csvColumns(modelAtom)]) + '\n';
// the kind map an importer uses to coerce each cell, keyed by (possibly dotted) column
// name — an embed's sub-columns are coerced by the sub-model's own field kinds.
async function csvKinds(modelAtom, prefix = '', depth = 0) {
  const out = {};
  for (const [k, def] of Object.entries(modelAtom.attr.fields || {})) {
    const sub = embedOf(def);
    if (sub && depth < 6) Object.assign(out, await csvKinds(await getAtom(sub), `${prefix}${k}.`, depth + 1));
    else out[prefix + k] = (typeof def === 'string') ? 'text' : (def.kind || 'text');
  }
  return out;
}
// export a set of atoms. modelId null → cross-model (an index over atom://atom).
async function atomsCsv(modelId, atoms) {
  if (!modelId) {
    const lines = [csvRow(['id', 'model', 'manifest', 'createdAt'])];
    for (const a of atoms) lines.push(csvRow([a.id, refId(a.model), a.manifest || '', a.lifecycle?.createdAt || '']));
    return lines.join('\n') + '\n';
  }
  const cols = await csvColumns(await getAtom(modelId));
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
async function csvToBodies(modelId, text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const kinds = await csvKinds(await getAtom(modelId));
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
    const made = await tx(async () => {
      const acc = [];
      for (const b of bodies) acc.push(await create(modelId, b, actor));
      return acc;
    });
    for (const a of made) await runHooks(a, 'create');   // hooks fire post-commit
    return { imported: made.length, failed: [] };
  }
  // default: per-row best-effort — each row that validates is kept, each that
  // fails is reported, and the response is a summary (Import is still POST-many).
  const out = { imported: 0, failed: [] };
  for (let i = 0; i < bodies.length; i++) {
    try { const a = await create(modelId, bodies[i], actor); await runHooks(a, 'create'); out.imported++; }
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
async function applyOp(op, actor, i) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Err(400, `op ${i}: must be an object`);
  const { op: verb, ifMatch, ...body } = op;       // body = the create/update payload (attr, manifest, id, parent, hooks…)
  switch (verb) {
    case 'create':
      if (!op.model) throw new Err(400, `op ${i}: create needs a model`);
      return { atom: await create(bareId(op.model), body, actor), event: 'create' };
    case 'update':
      if (!op.id) throw new Err(400, `op ${i}: update needs an id`);
      return { atom: await update(bareId(op.id), body, actor, ifMatch), event: 'update' };
    case 'replace':
      if (!op.id) throw new Err(400, `op ${i}: replace needs an id`);
      return { atom: await replace(bareId(op.id), body, actor, ifMatch), event: 'update' };
    case 'delete':
      if (!op.id) throw new Err(400, `op ${i}: delete needs an id`);
      return { atom: await retire(bareId(op.id), actor), event: 'delete' };
    default:
      throw new Err(400, `op ${i}: unknown op "${verb}" — use create | update | replace | delete`);
  }
}
async function txBatch(ops, actor) {
  if (!Array.isArray(ops)) throw new Err(400, '/tx expects a JSON array of operations');
  if (!ops.length) return { ok: true, results: [] };
  const effects = [];
  await tx(async () => { for (let i = 0; i < ops.length; i++) effects.push(await applyOp(ops[i], actor, i)); });
  // committed — now fire the same post-write tails the REST verbs run, in order.
  for (const { atom, event } of effects) {
    await runHooks(atom, event);
    if (event !== 'delete' && atom.model === 'atom://model') await sweepModel(atom.id);
    if (event === 'create' && atom.model === 'atom://migration') await sweepModel(refId(atom.attr.model));
  }
  return { ok: true, results: effects.map((e) => e.atom) };
}

async function renderTable(modelId, atoms, actor) {
  const m = await getAtom(modelId);
  const fields = m.attr.fields || {};
  const cols = m.attr.display?.row || Object.keys(fields);
  const head = ['id', ...cols].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = [];
  for (const a of atoms) {
    const canEditRow = await writable(actor, a);   // tenant scope + write rule, once per row
    const cells = [];
    for (const c of cols) cells.push(await gridCell(actor, modelId, a, c, fields[c], canEditRow));
    rows.push(`<tr><td>${await link(actor, a.id)}</td>` + cells.join('') + '</tr>');
  }
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></figure>`;
}
// one data cell of the grid. Inline-editable — click, type, Tab to the next — when
// the actor may update this field on this atom and the field is a simple scalar;
// ref/embed/list/map/json/longtext stay read-only (open the row to edit those). An
// edit is a single-field PATCH with If-Match (wired in app.js); the per-field grant
// and optimistic-concurrency version already exist server-side, so this is the spec
// of "what is editable here" rendered straight from the model + grants.
async function gridCell(actor, modelId, a, c, def, canEditRow) {
  const v = a.attr?.[c];
  if (!def || !canEditRow || !await allows(actor, `${modelId}.${c}`, 'update'))
    return `<td>${await atomValue(v, actor)}</td>`;
  const kind = embedOf(def) ? 'embed' : (def.kind || 'text');
  if (['ref', 'embed', 'list', 'map', 'json', 'longtext'].includes(kind))
    return `<td>${await atomValue(v, actor)}</td>`;
  const meta = `data-id="${esc(a.id)}" data-field="${esc(c)}" data-ver="${a.lifecycle?.version ?? 0}"`;
  if (kind === 'enum')
    return `<td data-edit ${meta}><select>${['', ...(def.values || [])]
      .map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></td>`;
  if (kind === 'boolean')
    return `<td data-edit ${meta}><input type="checkbox"${v ? ' checked' : ''}></td>`;
  const dk = (kind === 'number' || kind === 'integer') ? 'number' : 'text';
  return `<td data-edit contenteditable data-kind="${dk}" ${meta}>${v === undefined || v === null ? '' : esc(v)}</td>`;
}

// a form to create a session (sign in) — a session is itself an atom
async function sessionForm() {
  const open = (await store.query({ model: 'atom://token' })).filter((a) => a.attr.login === 'open');
  const items = open.map((t) => `<li><a href="/auth/open?token=${esc(t.id)}">atom://${esc(t.id)}</a></li>`).join('');
  return `<form method="post" action="/auth"><p><input name="email" type="email" placeholder="you@example.com" required></p><p><button>send magic link</button></p></form>
${open.length ? `<ul>${items}</ul>` : ''}`;
}

// one form generated from the model's field kinds, with a method picker built
// from the actor's grants (the auth schema). Submit runs the chosen method.
async function renderForm(modelId, atom, actor) {
  const m = await getAtom(modelId);
  const editing = !!atom;
  const cur = atom?.attr || {};
  const json = (name, v) => `<textarea name="${esc(name)}" data-kind="json" rows="3">${v === undefined ? '' : esc(JSON.stringify(v, null, 2))}</textarea>`;
  // recursive: scalars -> inputs, ref -> autocomplete, object/embed -> nested
  // sub-table, list with a declared item type (`of`) -> a repeater. `depth` guards
  // against a self- or mutually-embedding model (e.g. `self: embed://self`) blowing
  // the stack: past the limit, the field falls back to a raw JSON textarea.
  async function control(name, def, v, depth = 0) {
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
  async function embed(name, subId, obj, depth = 0) {
    const sm = await getAtom(subId);
    const rows = [];
    for (const [k, def] of Object.entries(sm.attr.fields || {}))
      rows.push(`<tr><th>${esc(k)}</th><td>${await control(name + '.' + k, def, obj?.[k], depth + 1)}</td></tr>`);
    return `<figure><table>${rows.join('')}</table></figure>`;
  }
  async function repeater(name, ofDef, arr, depth = 0) {
    const items = arr.length ? arr : [undefined];
    const blocks = [];
    for (let i = 0; i < items.length; i++) blocks.push(`<fieldset>${await control(name + '.' + i, ofDef, items[i], depth + 1)}</fieldset>`);
    return `<fieldset data-name="${esc(name)}">${blocks.join('')}<button type="button">+ add</button></fieldset>`;
  }
  const wop = editing ? 'update' : 'create';
  const fieldRows = [];
  for (const [k, def] of Object.entries(m.attr.fields || {}))
    if (await allows(actor, `${modelId}.${k}`, wop)) // only fields the actor may write
      fieldRows.push(`<tr><th>${esc(k)}</th><td>${await control(k, def, cur[k])}</td></tr>`);
  // a datalist per model — its atoms (atom://) plus embed://<model> — for any ref at any depth
  const scope = (await getStore(actor)).all();
  const suggest = scope.filter((a) => a.model === 'atom://model').map((mm) =>
    `<datalist id="refs-${esc(mm.id)}">${scope.filter((a) => a.model === ref(mm.id) && a.lifecycle?.status !== 'retired')
      .map((a) => `<option value="atom://${esc(a.id)}">${esc(a.attr?.name || a.manifest || a.id)}</option>`).join('')}<option value="embed://${esc(mm.id)}"></option></datalist>`).join('');
  // the methods this actor may run here, from its grants (the auth schema)
  const methods = [];
  // a mutating method shows only when BOTH the grant (canOp) and the per-atom
  // write rule allow it — so e.g. Billy sees an edit form on his OWN index but
  // not on a shared/global one his grant covers yet the rule forbids.
  const mayWrite = !editing || await writable(actor, atom);
  if (!editing && await canOp(actor, modelId, 'create')) methods.push('POST', 'IMPORT');
  if (editing && mayWrite && await canOp(actor, modelId, 'update')) methods.push('PATCH', 'PUT');
  if (editing && mayWrite && await canOp(actor, modelId, 'delete')) methods.push('DELETE');
  if (!methods.length) return '';
  const LABEL = { POST: 'POST · create', IMPORT: 'IMPORT · bulk CSV', PUT: 'PUT · replace', PATCH: 'PATCH · update', DELETE: 'DELETE · delete' };
  // IMPORT mode (revealed by app.js when chosen): a template to fill + a dropzone
  // that POSTs the CSV to this model. The server bulk-creates it under the same
  // grants/rules as a single create. Only in create context (!editing).
  const importRow = (!editing && await canOp(actor, modelId, 'create'))
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
  return `<form data-create="${esc('/' + modelId)}" data-atom="${editing ? esc('/' + atom.id) : ''}"><figure><table>${methodRow}${idRows}${manifestRow}${fieldRows.join('')}${importRow}</table></figure><p><button>Submit</button></p>${suggest}</form>`;
}

// the top nav: indexes the actor can reach, then every model it can touch below.
async function navSelect(actor, current) {
  const all = (await getStore(actor)).all().filter((a) => a.lifecycle?.status !== 'retired');
  const opt = (a) => `<option value="/${esc(a.id)}"${a.id === current ? ' selected' : ''}>atom://${esc(a.id)}</option>`;
  const indexAtoms = await asyncFilter(all, async (a) => a.model === 'atom://index' && (await canTouch(actor, a.id) || await canTouch(actor, refId(a.attr.over))));
  const modelAtoms = await asyncFilter(all, async (a) => a.model === 'atom://model' && await canTouch(actor, a.id));
  const indexes = indexAtoms.map(opt).join('');
  const models = modelAtoms.map(opt).join('');
  return `<select data-nav><option value="/">atom://0</option>`
    + (indexes ? `<optgroup label="indexes">${indexes}</optgroup>` : '')
    + (models ? `<optgroup label="models">${models}</optgroup>` : '')
    + `</select>`;
}

// the signed-in identity line (shown under the logo): who + sign out
async function footer(actor) {
  if (!actor || actor.id === '0') return '';
  return `signed in as ${await atomValue(ref(actor.id), actor)} <a href="/auth/logout">sign out</a>`;
}

// Signed-in root: the workspace drawn plainly as a mind map — every model the
// actor can reach, its ref fields (the schema edges), and the atoms under it
// the actor may open. Nested <ul>s, nothing fancier.
async function workspaceMap(actor) {
  const all = (await getStore(actor)).all();
  const models = await asyncFilter(all, async (a) => a.model === 'atom://model' && await canTouch(actor, a.id));
  const branch = async (m) => {
    const fields = m.attr.fields || {};
    const refParts = [];
    for (const [f, d] of Object.entries(fields))
      if (d && typeof d === 'object' && d.kind === 'ref')
        refParts.push(`<li>${esc(f)} → ${await link(actor, refId(d.to))}</li>`);
    const refs = refParts.join('');
    const insts = await asyncFilter(all, async (a) => a.id !== m.id && refId(a.model) === m.id
      && a.lifecycle?.status !== 'retired' && await canSee(actor, a.id));
    const shownParts = [];
    for (const a of insts.slice(0, 12)) shownParts.push(`<li>${await link(actor, a.id)}</li>`);
    const shown = shownParts.join('');
    const more = insts.length > 12 ? `<li><small>… ${insts.length - 12} more</small></li>` : '';
    const kids = (refs ? `<li>refs<ul>${refs}</ul></li>` : '')
      + (insts.length ? `<li>atoms<ul>${shown}${more}</ul></li>` : '');
    return `<li>${await link(actor, m.id)} <small>${esc(m.attr.label || m.id)}</small>${kids ? `<ul>${kids}</ul>` : ''}</li>`;
  };
  const branches = [];
  for (const m of models) branches.push(await branch(m));
  return `<ul>${branches.join('')}</ul>`;
}

async function renderModelPage(modelId, atoms, actor, search = '') {
  const m = await getAtom(modelId);
  const canRd = await canOp(actor, modelId, 'read');
  const table = canRd ? await renderTable(modelId, atoms, actor) : ''; // hidden without read
  const qs = (search || '').replace(/^\?/, '');
  const exp = canRd ? `<a href="/${esc(modelId)}?${qs ? qs + '&' : ''}as=csv" download>export CSV</a>` : '';
  return page(`${m.attr.label || modelId} — ${atoms.length}`,
    await renderForm(modelId, null, actor) + table, await navSelect(actor, modelId) + exp, await footer(actor));
}

// cross-model table for indexes that span all models (over: atom://atom)
async function renderCrossTable(atoms, actor) {
  const head = ['id', 'model', 'manifest', 'createdAt'].map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = [];
  for (const a of atoms)
    rows.push(`<tr><td>${await link(actor, a.id)}</td><td>${await atomValue(a.model, actor)}</td>` +
      `<td>${esc(a.manifest || '')}</td><td>${esc(a.lifecycle?.createdAt || '')}</td></tr>`);
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></figure>`;
}

async function renderIndexPage(indexAtom, atoms, actor, values = {}) {
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
    const scope = (await getStore(actor)).all();
    const lists = targets.map((t) => `<datalist id="refs-${esc(t)}">${scope
      .filter((a) => a.model === ref(t) && a.lifecycle?.status !== 'retired')
      .map((a) => `<option value="atom://${esc(a.id)}">${esc(a.attr?.name || a.manifest || a.id)}</option>`).join('')}</datalist>`).join('');
    form = `<form method="get" action="/${esc(indexAtom.id)}"><figure><table>${rows}</table></figure><p><button>Run</button></p>${lists}</form>`;
  }
  let body = form + (over === 'atom' ? await renderCrossTable(atoms, actor) : await renderTable(over, atoms, actor));
  const pg = indexAtom.attr.page;
  if (pg && atoms.length) {
    const last = atoms[atoms.length - 1];
    const cur = (last.lifecycle?.[pg.cursor]) ?? last.attr?.[pg.cursor];
    body += `<p><a href="/${esc(indexAtom.id)}?before=${encodeURIComponent(cur)}">older →</a></p>`;
  }
  // the index's own create/edit form — POST a new report on the model page, or
  // PATCH/PUT/DELETE one you own here (renderForm gates by grant + the write rule)
  body += await renderForm('index', indexAtom, actor);
  const ps = new URLSearchParams(values); ps.delete('as'); ps.set('as', 'csv');
  const exp = `<a href="/${esc(indexAtom.id)}?${esc(ps.toString())}" download>export CSV</a>`;
  return page(`${indexAtom.attr.label || indexAtom.id} — ${atoms.length}`, body, await navSelect(actor, indexAtom.id) + exp, await footer(actor));
}

// every place a ref to `target` appears in a value, with its dotted field path
function findRefs(v, target, prefix) {
  if (v === target) return [prefix || 'attr'];
  if (Array.isArray(v)) return v.flatMap((x) => findRefs(x, target, prefix));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, val]) => findRefs(val, target, prefix ? `${prefix}.${k}` : k));
  return [];
}
// the ref map: everything in scope that references this atom (attr or lifecycle)
async function referencedBy(atom, actor) {
  const target = ref(atom.id), out = [];
  for (const a of (await getStore(actor)).all()) {
    if (a.id === atom.id || a.lifecycle?.status === 'retired') continue;
    if (!await canSee(actor, a.id)) continue;   // only backlinks the actor may actually read
    for (const via of findRefs(a.attr, target, '')) out.push({ id: a.id, model: refId(a.model), via, label: a.manifest || a.attr?.name || a.id });
    for (const via of findRefs(a.lifecycle, target, '')) out.push({ id: a.id, model: refId(a.model), via: `lifecycle.${via}`, label: a.manifest || a.attr?.name || a.id });
  }
  return out;
}
async function renderRefMap(rows, actor) {
  if (!rows.length) return '';
  const head = ['referenced by', 'model', 'via'].map((c) => `<th>${esc(c)}</th>`).join('');
  const cells = [];
  for (const r of rows.slice(0, 200))
    cells.push(`<tr><td>${await link(actor, r.id)}</td><td>${await atomValue('atom://' + r.model, actor)}</td><td>${esc(r.via)}</td></tr>`);
  return `<figure><table><thead><tr>${head}</tr></thead><tbody>${cells.join('')}</tbody></table></figure>`;
}

async function renderAtom(atom, actor) {
  const modelId = refId(atom.model);
  // the UI mirrors the schema: render the whole atom — id, model, manifest,
  // attr, lifecycle — then the ref map (everything that references it)
  const body = await renderFields(atom, actor) + await renderForm(modelId, atom, actor) + await renderRefMap(await referencedBy(atom, actor), actor);
  return page(atom.manifest || atom.id, body, await navSelect(actor, refId(atom.model)), await footer(actor));
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
      const tok = (await store.query({ model: 'atom://token' })).find((a) => a.attr.email === email);
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
      return redirect('/', sessionCookie(await newSession(rec.token)));
    }
    if (req.method === 'GET' && path === 'auth/open') {
      const id = url.searchParams.get('token');
      const t = id && await store.get(id);
      if (!t || t.model !== 'atom://token' || t.attr.login !== 'open') return send(403, { error: 'not an open-login token' });
      return redirect('/', sessionCookie(await newSession(t.id)));
    }
    if (req.method === 'GET' && path === 'auth/logout') {
      const sid = cookies['atomic_session'];
      if (sid && await store.has(sid)) { const s = await store.get(sid); s.lifecycle.status = 'retired'; await store.set(s.id, s); }
      return redirect('/', sessionCookie('', 0));
    }

    const actor = await actorFromReq(req, cookies);
    const isAnon = actor.id === '0';
    const [head, ...segs] = path.split('.');

    // A session is a bearer credential, not an addressable resource. No request
    // (any method, any actor) may read, traverse, or write one through the
    // surface — sign-in/out happen only via the /auth/* routes handled above.
    if (head && await store.has(head) && (await getAtom(head)).model === 'atom://session')
      throw new Err(404, `no atom ${head}`);

    // the root is atom://0 — render it like any atom; anon also gets a create-session form
    if (req.method === 'GET' && path === '') {
      const a = await getAtom('0');
      if (!wantsHtml) return send(200, a);
      let body = await renderFields(a, actor);
      body += isAnon ? await sessionForm() : await workspaceMap(actor);
      return send(200, page(a.manifest || 'atom://0', body, await navSelect(actor, ''), await footer(actor)), true);
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

    // --- /base: provision a new base (superuser only) — one tenant + one open-login
    // token scoped to it. Returns the tenant, the token, and a one-click share URL.
    if (req.method === 'POST' && path === 'base') {
      const { name } = await readBody(req);
      const { tenant, token } = await provisionBase(name, actor);
      return send(201, { tenant: ref(tenant.id), token: ref(token.id), url: `${origin}/auth/open?token=${token.id}` });
    }

    // an atom id may itself contain dots (index ids like 'atom.byDate'); a whole-
    // path match on a real atom wins over dot-path traversal of atom://atom.
    if (req.method === 'GET' && path && await store.has(path) && (await getAtom(path)).model === 'atom://index') {
      const ix = await getAtom(path);
      if (!await visible(actor, ix)) throw new Err(404, `no atom ${path}`); // can't run an index outside your tenant
      const atoms = await runIndex(ix, url.search, actor);
      if (as === 'csv') return sendCsv(`${ix.id}.csv`, await atomsCsv(refId(ix.attr.over) === 'atom' ? null : refId(ix.attr.over), atoms));
      if (wantsHtml) return send(200, await renderIndexPage(ix, atoms, actor, Object.fromEntries(url.searchParams)), true);
      return send(200, atoms);
    }

    if (req.method === 'GET') {
      // atom://atom is the universal type — every atom, newest first
      if (head === 'atom' && segs.length === 0) {
        const readable = await asyncFilter((await getStore(actor)).all(), (a) => readableAtom(actor, a));
        const sorted = sortBy(readable, '-createdAt');
        const atoms = [];
        for (const a of sorted) atoms.push(await redact(actor, a));
        if (wantsHtml) return send(200, page('atom — every atom', await renderCrossTable(atoms, actor), await navSelect(actor, ''), await footer(actor)), true);
        return send(200, atoms);
      }
      const headAtom = await getAtom(head);
      const q = parseQuery(url.search);
      let result;
      if (headAtom.model === 'atom://index') {
        if (!await visible(actor, headAtom)) throw new Err(404, `no atom ${head}`); // can't run an index outside your tenant
        const atoms = await runIndex(headAtom, url.search, actor);
        if (as === 'csv') return sendCsv(`${headAtom.id}.csv`, await atomsCsv(refId(headAtom.attr.over) === 'atom' ? null : refId(headAtom.attr.over), atoms));
        if (wantsHtml) return send(200, await renderIndexPage(headAtom, atoms, actor, Object.fromEntries(url.searchParams)), true);
        result = atoms;
      } else if (headAtom.model === 'atom://model' && segs.length === 0) {
        // a tenant-scoped model is invisible (and unaddressable) outside its tenant;
        // global/core models (tenant-less) stay listable by everyone.
        if (!await visible(actor, headAtom)) throw new Err(404, `no atom ${head}`);
        // a blank template to fill for import (gated on create — you template what you can import)
        if (as === 'template') {
          if (!await canOp(actor, head, 'create')) throw new Err(403, `${actor.id} cannot import ${head}`);
          return sendCsv(`${head}-template.csv`, await templateCsv(headAtom));
        }
        const atoms = await listModel(head, q, actor);           // already gated by read
        if (as === 'csv') return sendCsv(`${head}.csv`, await atomsCsv(head, atoms));
        if (wantsHtml) return send(200, await renderModelPage(head, atoms, actor, url.search), true);
        result = atoms;
      } else if (segs.length) {
        // a dotted path is a read like any other: gate the head atom, then traverse
        // under the actor so every hop and field honors scope + grants + rules.
        if (!await canSee(actor, head)) throw new Err(404, `no atom ${head}`);
        result = await traverse(headAtom, segs, actor);
      }
      else {
        if (!await visible(actor, headAtom) || !await canOp(actor, refId(headAtom.model), 'read') || !await ruleOk(actor, headAtom, 'read'))
          throw new Err(404, `no atom ${head}`);
        await bringForward(headAtom);             // lazy schema evolution: behind atoms are migrated on read
        const a = await redact(actor, headAtom);
        if (wantsHtml) return send(200, await renderAtom(a, actor), true);
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
        return send(200, await bulkCreate(head, await csvToBodies(head, text), actor, atomic));
      }
      const body = await readBody(req);
      if (Array.isArray(body)) return send(200, await bulkCreate(head, body, actor, atomic));
      const a = await create(head, body, actor); await runHooks(a, 'create');
      if (a.model === 'atom://migration') await sweepModel(refId(a.attr.model)); // a new migration brings its model's atoms forward
      return send(201, tokenCreateView(a)); // a token surfaces its clear API secret here, once
    }
    if (req.method === 'PUT') { const a = await replace(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); if (a.model === 'atom://model') await sweepModel(a.id); return send(200, a); }
    if (req.method === 'PATCH') { const a = await update(head, await readBody(req), actor, req.headers['if-match']); await runHooks(a, 'update'); if (a.model === 'atom://model') await sweepModel(a.id); return send(200, a); }
    if (req.method === 'DELETE') { const a = await retire(head, actor); await runHooks(a, 'delete'); return send(200, a); }
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
    // a test is an atom that asserts a request's outcome — the substrate carries its
    // OWN acceptance suite, as data. `node atomic.mjs --check` runs every test atom
    // over the live HTTP surface, as its `as` token, and checks the response `status`
    // plus any `condition` atoms (reused as the assertion language) against the body.
    // A test is listable, editable, exportable, tenant-scoped, and in the ledger like
    // any atom — a tenant can ship acceptance tests for its own models.
    model('test', 'Test', { label: { kind: 'text' },
      as: { kind: 'ref', to: 'atom://token' },
      method: { kind: 'enum', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { kind: 'text', required: true }, body: { kind: 'json' }, expect: { kind: 'json' } }),

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

    // core self-tests — the substrate's own acceptance suite, as atoms, run by
    // `--check`. These need no fixtures: they assert the core surface itself, are
    // read-only (idempotent, safe to re-run), and one reuses a condition atom to
    // check a value on the response. A `test` field `as` names the actor; `atom://0`
    // is anonymous (no bearer). This is "the kernel supplies its own tests."
    atom('cond-root-is-0', 'condition', "the root atom's id is 0", { label: 'root id == 0', field: 'id', op: 'eq', value: '0' }),
    atom('test-root-readable',    'test', 'anyone can read the root atom',     { label: 'root readable by anyone', as: 'atom://0',    method: 'GET', path: '/',            expect: { status: 200, conditions: ['atom://cond-root-is-0'] } }),
    atom('test-anon-blocked',     'test', 'anonymous cannot read data',         { label: 'anon blocked from /token', as: 'atom://0',    method: 'GET', path: '/token',       expect: { status: 401 } }),
    atom('test-models-listable',  'test', 'the admin can list the models',      { label: 'models listable',          as: 'atom://joey', method: 'GET', path: '/model',       expect: { status: 200 } }),
    atom('test-suite-self-visible','test', 'the suite is itself a set of atoms', { label: 'tests are atoms',          as: 'atom://joey', method: 'GET', path: '/test',        expect: { status: 200 } }),
    atom('test-unknown-404',      'test', 'an unknown id is a 404',             { label: 'unknown id → 404',         as: 'atom://joey', method: 'GET', path: '/no-such-atom', expect: { status: 404 } }),
  ];
}

// ---------------------------------------------------------------------------
// Bootstrap — fresh store: seed every core atom, then log each as genesis.
// Demo tenants A / B / C / D are loaded from seeds/seed-*.mjs (POSTed through the API
// as the admin) so they never bloat the kernel.
// ---------------------------------------------------------------------------
async function bootstrap() {
  for (const a of coreAtoms()) await seed(a);
  await buildInverse();
  // genesis ledger: every seeded atom is itself a logged change — everything is logged
  for (const a of [...await store.values()]) {
    if (a.model === 'atom://log') continue;
    const by = typeof a.lifecycle === 'object' ? refId(a.lifecycle.createdBy) : '0';
    await logIt(a.id, 'genesis', by, changeset({}, a.attr));
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
    if (!await store.has(a.id)) { await seed(a); added++; continue; }
    // keep the core MODEL definitions current: their schema (fields/rules/etc.)
    // is the substrate's own, versioned with the kernel — so an older store gains
    // new field kinds, write rules, and validation as the kernel evolves. Only
    // core models are refreshed; tenant data and demo models are never touched.
    if (a.model === 'atom://model') {
      const cur = await store.get(a.id);
      if (JSON.stringify(cur.attr) !== JSON.stringify(a.attr)) { cur.attr = a.attr; await bump(cur, '0'); refreshed++; }
    }
  }
  // the root atom is the app's own self-description, carried in its manifest
  // (it holds no data — attr is empty). Keep an older store's copy tracking the
  // canonical definition; the header tagline renders straight from this manifest.
  const root = await store.get('0'), def0 = core.find((a) => a.id === '0');
  if (root && def0 && (root.manifest !== def0.manifest || Object.keys(root.attr || {}).length)) {
    root.manifest = def0.manifest;
    root.attr = {}; // atom://0 holds no data, only its label
    await bump(root, '0');
  }
  let n = 0;
  for (const a of await store.values()) {
    if (a.lifecycle && typeof a.lifecycle === 'object' && !a.lifecycle.expiration) {
      a.lifecycle.expiration = await tenantOf(a) === null ? 'atom://policy-never' : 'atom://policy-default';
      await persist(a); n++;
    }
  }
  await buildInverse();
  // schema evolution: bring every atom of a migrated model up to the current
  // version — the "background job, run to completion on boot" (README).
  const sgBefore = storeGen; await sweepAll(); const migrated = storeGen > sgBefore;
  if (added || refreshed || n || migrated) console.error(`migrate: +${added} core atoms, refreshed ${refreshed} core models, backfilled expiration on ${n}, applied schema migrations`);
}

// ---------------------------------------------------------------------------
// Governance — `node atomic.mjs --audit` (or `npm run audit`). A self-check over
// the loaded store, in the spirit of a fsck: it asserts the substrate's own
// invariants and exits non-zero on any finding, so it slots into CI / a cron.
// Point it at a real store with ATOMIC_STORE=… (and ATOMIC_KEY=… if encrypted).
// ---------------------------------------------------------------------------
async function audit() {
  const PSEUDO = new Set(['atom']); // atom://atom is the universal pseudo-model, not a stored atom
  const atoms = [...await store.values()];
  // materialize the id set once so the per-atom checks stay synchronous over the
  // already-loaded snapshot (rather than an async store probe per reference).
  const byId = new Map(atoms.map((a) => [a.id, a]));
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
    const m = byId.get(refId(a.model));
    return !m || m.model !== 'atom://model';
  }).map((a) => `${a.id} → ${a.model}`));

  // every atom:// reference in data resolves (the 'atom' pseudo-model excepted)
  const dangling = new Set();
  for (const a of atoms) for (const id of [...refsIn(a.attr), ...refsIn(a.lifecycle)])
    if (!PSEUDO.has(id) && !byId.has(id)) dangling.add(`${a.id} → atom://${id}`);
  report('every reference resolves', [...dangling]);

  // every atom's attr conforms to its model's declared schema
  const badSchema = [];
  for (const a of atoms) {
    try { await validate(refId(a.model), a.attr); } catch { badSchema.push(a.id); }
  }
  report('every atom conforms to its schema', badSchema);

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
    return isRef(p) && refId(p) !== a.id && !byId.has(refId(p));
  }).map((a) => `${a.id} → ${a.lifecycle.parent}`));

  console.log(`\naudit: ${atoms.length} atoms, ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  return findings.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Self-tests — `node atomic.mjs --check` (or `npm run check`). The substrate
// carries its own acceptance suite as `test` atoms (see the `test` model); this
// runs each over the live HTTP surface, as its `as` token, and checks the response
// `status` plus any `condition` atoms — reused as the assertion language — against
// the response body (a dotted `field` reads id / manifest / attr.x.y / lifecycle.*).
// Read-only and negative (non-2xx) tests don't mutate, so --check is re-runnable in
// CI. It listens on an ephemeral local port, runs, and exits non-zero on any failure.
// ---------------------------------------------------------------------------
async function check() {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const at = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const holds = (payload, cond) => {
    const { field, op, value } = cond?.attr || {};
    const v = at(payload, field);
    return op === 'eq' ? v === value : op === 'ne' ? v !== value
      : op === 'in' ? (Array.isArray(value) && value.includes(v)) : false;
  };
  const tests = (await store.query({ model: 'atom://test' }))
    .filter((t) => t.lifecycle?.status !== 'retired')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  let pass = 0, fail = 0;
  for (const t of tests) {
    const a = t.attr || {}, exp = a.expect || {};
    const asId = a.as ? (isRef(a.as) ? refId(a.as) : a.as) : null;
    const headers = {};
    if (asId && asId !== '0' && await store.has(asId)) headers.authorization = 'Bearer ' + await newSession(asId); // a session, not the public id
    if (a.body !== undefined) headers['content-type'] = 'application/json';
    let ok = true, why = '';
    try {
      const r = await fetch(base + a.path, { method: a.method || 'GET', headers,
        body: a.body !== undefined ? JSON.stringify(a.body) : undefined });
      if (exp.status !== undefined && r.status !== exp.status) { ok = false; why = `status ${r.status} ≠ ${exp.status}`; }
      if (ok && (exp.conditions?.length || exp.count !== undefined)) {
        const payload = await r.json().catch(() => null);
        if (exp.count !== undefined) {
          const n = Array.isArray(payload) ? payload.length : -1;
          if (n !== exp.count) { ok = false; why = `count ${n} ≠ ${exp.count}`; }
        }
        for (const cref of (ok ? (exp.conditions || []) : [])) {
          const cond = await store.get(isRef(cref) ? refId(cref) : cref);
          if (!cond || !holds(payload, cond)) { ok = false; why = `condition ${cref} failed`; break; }
        }
      }
    } catch (e) { ok = false; why = e.message; }
    ok ? pass++ : fail++;
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${t.id}: ${a.label || a.path}${ok ? '' : `  (${why})`}`);
  }
  console.log(`\ncheck: ${pass} passed, ${fail} failed`);
  await new Promise((res) => server.close(res));
  return fail ? 1 : 0;
}

if (await loadAll()) {           // durable store on disk -> replay it
  await buildInverse();
  logSeq = [...await store.values()].reduce((m, a) => a.id.startsWith('log-') ? Math.max(m, +a.id.slice(4) || 0) : m, 0);
  await migrate();               // evolve an older store forward (idempotent): core atoms + schema migrations
} else {
  await bootstrap();             // fresh -> seed (and persist, if ATOMIC_STORE is set)
}

// Optional: a clear admin API secret from the environment. When ATOMIC_ADMIN_SECRET
// is set, the genesis admin token can be used non-interactively as `Bearer <secret>`
// (for CI / seeds); unset, the admin authenticates only via the magic-link flow.
// We store only the hash, like every other token.
if (process.env.ATOMIC_ADMIN_SECRET) {
  const joey = await store.get('joey');
  if (joey?.model === 'atom://token') {
    const h = sha256(process.env.ATOMIC_ADMIN_SECRET);
    if (joey.attr.secret !== h) { joey.attr.secret = h; await persist(joey); }
  }
}

// Backfill the secondary index for a store written before it existed (a fresh
// bootstrap already indexed as it seeded, so this is a one-time upgrade step). If
// the index is empty but atoms exist, project every atom once, in one transaction.
if (store.indexCount && await store.count() > 0 && await store.indexCount() === 0) {
  await store.transact(async () => {
    for (const a of await store.values()) await store.setIndex(a.id, await shardOf(a), a.model, await indexRows(a));
  });
  console.error(`indexed ${await store.count()} atoms into the secondary index`);
}

if (process.argv.includes('--audit')) process.exit(await audit()); // governance check, then stop — never listens
if (process.argv.includes('--check')) process.exit(await check()); // self-tests (the test atoms), then stop

// `node atomic.mjs --new-base "<name>"` — provision a base from the command line and
// print its one-click share URL. Persists if ATOMIC_STORE is set, then stops.
const _nb = process.argv.indexOf('--new-base');
if (_nb !== -1) {
  const name = process.argv[_nb + 1] || 'New Base';
  const { tenant, token } = await provisionBase(name, await getAtom('joey'));
  const origin = process.env.ATOMIC_ORIGIN || `http://localhost:${process.env.PORT || 3040}`;
  console.log(`base "${name}" provisioned`);
  console.log(`  tenant:    atom://${tenant.id}`);
  console.log(`  share URL: ${origin}/auth/open?token=${token.id}`);
  process.exit(0);
}
// `node atomic.mjs --export-base <tenant> > base.ndjson` — a portable base is one
// file: the tenant atom plus every atom in its shard, one JSON object per line.
const _eb = process.argv.indexOf('--export-base');
if (_eb !== -1) {
  const t = process.argv[_eb + 1];
  if (!t || !await store.has(t)) { console.error(`usage: --export-base <tenant-id>  (no atom "${t}")`); process.exit(2); }
  let n = 0; const seen = new Set();
  for (const a of [await store.get(t), ...await store.query({ shards: [t] })]) {
    if (!a || seen.has(a.id)) continue; seen.add(a.id);
    process.stdout.write(JSON.stringify(a) + '\n'); n++;
  }
  console.error(`exported ${n} atoms of base ${t}`);
  process.exit(0);
}
// `--export-all > all.ndjson` then `ATOMIC_DB=… --import-all all.ndjson` migrates a
// whole store between drivers (e.g. SQLite → Postgres). Export dumps every atom;
// import writes each verbatim (preserving id + lifecycle) and rebuilds the index, in
// one transaction. Idempotent: re-importing overwrites by id.
if (process.argv.includes('--export-all')) {
  let n = 0;
  for (const a of await store.values()) { process.stdout.write(JSON.stringify(a) + '\n'); n++; }
  console.error(`exported ${n} atoms`);
  process.exit(0);
}
const _ia = process.argv.indexOf('--import-all');
if (_ia !== -1) {
  const file = process.argv[_ia + 1];
  if (!file || !fs.existsSync(file)) { console.error(`usage: --import-all <file.ndjson>  (no file "${file}")`); process.exit(2); }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let n = 0;
  await store.transact(async () => {
    for (const line of lines) {
      const a = parseLine(line);
      await store.set(a.id, a);
      if (store.setIndex) await store.setIndex(a.id, await shardOf(a), a.model, await indexRows(a));
      n++;
    }
  });
  console.error(`imported ${n} atoms into ${ATOMIC_DB ? 'postgres' : ROOT ? 'sqlite' : 'memory'}`);
  process.exit(0);
}

const PORT = process.env.PORT || 3040; // matches the seeds' default base and the documented live port
const bootCount = await store.count();
server.listen(PORT, () => {
  console.log(`atomic kernel on http://localhost:${PORT}  (${bootCount} atoms${ROOT ? `, persisted -> ${ROOT}` : ', in-memory'})`);
});

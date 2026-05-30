import { setPath } from './setpath.js';

// The generated create/edit form (present only when the actor may write here).
// Data-driven: it reads its target URLs from data-create / data-atom on the
// <form>, so this stays page-agnostic. Wires the list repeaters and submit, and
// returns the form element (or null if there is none) for initImport to extend.
export function initForm() {
  var F = document.querySelector('form[data-create]');
  if (!F) return null;
  var createUrl = F.getAttribute('data-create'), atomUrl = F.getAttribute('data-atom') || '';

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

  return F;
}

// Atomic — the whole client. Two behaviours, both progressive: click-to-sort on
// any data grid, and the generated create/edit form's submit + repeater. Served
// static and same-origin so the page can run under a strict CSP (script-src
// 'self', no inline script). The form is data-driven: it reads its target URLs
// from data-create / data-atom on the <form>, so this file is page-agnostic.
(function () {
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
})();

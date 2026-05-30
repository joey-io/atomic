// IMPORT method: reveal the template + dropzone, hide the normal create rows, and
// upload the dropped/picked CSV to the model (the API bulk-creates it). Takes the
// form element initForm returned; a no-op when there is no form or no import row.
export function initImport(F) {
  if (!F) return;
  var methodSel = F.querySelector('[name="$method"]');
  var importRow = F.querySelector('[data-import-row]');
  if (!(methodSel && importRow)) return;

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

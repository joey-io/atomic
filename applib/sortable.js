import { num } from './num.js';

// Sortable data grids: a <table> with a <thead>, not inside a form. Click a
// header cell to sort its column — numeric where both cells parse, else text.
export function initSortable() {
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
}

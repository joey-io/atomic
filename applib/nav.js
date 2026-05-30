// Nav dropdown: jump to the selected ref. Wired here (not an inline onchange) so
// it runs under the strict CSP, and it works on read-only pages too.
export function initNav() {
  document.querySelectorAll('select[data-nav]').forEach(function (sel) {
    sel.addEventListener('change', function () { if (sel.value) location.href = sel.value; });
  });
}

// Atomic — the whole client, assembled from one module per behaviour. Served
// static and same-origin so the page runs under a strict CSP (script-src 'self',
// no inline script). Loaded as <script type="module">, so these resolve as a
// module graph. Both behaviours are progressive: click-to-sort on any data grid,
// and the generated create/edit form's submit + repeaters + CSV import.
import { initSortable } from './sortable.js';
import { initNav } from './nav.js';
import { initForm } from './form.js';
import { initImport } from './import.js';

initSortable();
initNav();
initImport(initForm());

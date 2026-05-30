import { atom } from './_lib.mjs';

// Every model in the substrate, by id.
export default atom('model.all', 'index', 'Every model in the substrate', {
  label: 'All models',
  over: 'atom://model',
  sort: [{ id: 'asc' }],
  returns: 'set',
});

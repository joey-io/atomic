// Database-neutral analytical projection contract.
// Adapter: publish(events) -> count, history(atomId,{limit}) -> event rows.
// Delivery is at-least-once; event_id identifies retries. Canonical writes stay transactional.
export function validateAnalyticalEvent(e) {
  if (!e || !e.event_id || !e.atom_id || !e.model || !e.operation ||
      !Number.isSafeInteger(e.version) || e.version < 0) throw new TypeError('Invalid analytical event');
  return e;
}
export function validateAnalyticalAdapter(adapter) {
  if (!adapter || typeof adapter.publish !== 'function' || typeof adapter.history !== 'function')
    throw new TypeError('Analytical adapter requires publish(events) and history(atomId,options)');
  return adapter;
}

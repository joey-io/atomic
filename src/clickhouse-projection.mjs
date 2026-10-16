// Append-only analytical projection. Canonical writes remain in Atomic's transactional store.
// Client contract: async insert({table, values, format}) as in ClickHouse JS clients.
const safeTable = name => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) throw new Error('Invalid ClickHouse table');
  return name;
};
export const CLICKHOUSE_DDL = `CREATE TABLE IF NOT EXISTS atomic_events (
  event_id String, atom_id String, model String, operation LowCardinality(String),
  version UInt64, recorded_at DateTime64(3, 'UTC'), payload String
) ENGINE = MergeTree ORDER BY (atom_id, version, event_id)`;

/** A durable outbox is required between canonical commit and publish for crash safety.
 * This projector does not claim exactly-once delivery; consumers dedupe by event_id. */
export function createClickHouseProjector({ client, table = 'atomic_events' }) {
  if (!client || typeof client.insert !== 'function') throw new TypeError('ClickHouse client.insert required');
  safeTable(table);
  return {
    async publish(events) {
      const batch = Array.isArray(events) ? events : [events];
      const values = batch.map(e => {
        if (!e.event_id || !e.atom_id || !e.model || !e.operation || !Number.isSafeInteger(e.version) || e.version < 0)
          throw new TypeError('Invalid projection event');
        return { event_id: e.event_id, atom_id: e.atom_id, model: e.model,
          operation: e.operation, version: e.version,
          recorded_at: new Date(e.recorded_at ?? Date.now()).toISOString().replace('T', ' ').replace('Z', ''),
          payload: JSON.stringify(e.payload ?? null) };
      });
      if (values.length) await client.insert({ table, values, format: 'JSONEachRow' });
      return values.length;
    }
  };
}

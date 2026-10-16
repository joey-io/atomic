import { validateAnalyticalEvent } from './analytical-adapter.mjs';
// Client contract: execute({sqlText, binds}) -> rows (or {rows}).
// Caller supplies an authenticated Snowflake connection. Identifiers cannot be bind parameters.
const identifier = s => {
  if (typeof s !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/.test(s))
    throw new TypeError('Invalid Snowflake table identifier');
  return s;
};
export const SNOWFLAKE_DDL = `CREATE TABLE IF NOT EXISTS ATOMIC_EVENTS (
 EVENT_ID VARCHAR, ATOM_ID VARCHAR, MODEL VARCHAR, OPERATION VARCHAR,
 VERSION NUMBER(38,0), RECORDED_AT TIMESTAMP_NTZ, PAYLOAD VARIANT
)`;
export function createSnowflakeAdapter({client,table='ATOMIC_EVENTS'}) {
  if (!client || typeof client.execute !== 'function') throw new TypeError('Snowflake client.execute required');
  identifier(table);
  const execute = async (sqlText, binds) => {
    const result = await client.execute({sqlText,binds});
    return Array.isArray(result) ? result : (result?.rows ?? []);
  };
  return {
    async publish(events) {
      const batch = (Array.isArray(events) ? events : [events]).map(validateAnalyticalEvent);
      for (const e of batch) {
        const date = new Date(e.recorded_at ?? Date.now());
        if (Number.isNaN(date.getTime())) throw new TypeError('Invalid recorded_at');
        await execute(`INSERT INTO ${table} (EVENT_ID,ATOM_ID,MODEL,OPERATION,VERSION,RECORDED_AT,PAYLOAD)
          SELECT ?,?,?,?, ?,TO_TIMESTAMP_NTZ(?),PARSE_JSON(?)`,
          [e.event_id,e.atom_id,e.model,e.operation,e.version,date.toISOString(),JSON.stringify(e.payload ?? null)]);
      }
      return batch.length;
    },
    async history(atomId,{limit=100}={}) {
      if (typeof atomId !== 'string' || !atomId) throw new TypeError('atomId required');
      if (!Number.isInteger(limit) || limit<1 || limit>10000) throw new RangeError('limit must be 1..10000');
      return execute(`SELECT EVENT_ID,ATOM_ID,MODEL,OPERATION,VERSION,RECORDED_AT,PAYLOAD
        FROM ${table} WHERE ATOM_ID = ? ORDER BY VERSION DESC,EVENT_ID DESC LIMIT ?`,[atomId,limit]);
    }
  };
}

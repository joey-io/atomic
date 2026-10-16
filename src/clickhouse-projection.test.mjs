import test from 'node:test';
import assert from 'node:assert/strict';
import { createClickHouseProjector } from './clickhouse-projection.mjs';
test('projects events without changing canonical data', async () => {
  let sent;
  const p = createClickHouseProjector({client:{insert: async x => {sent=x;}}});
  const payload={attr:{a:1}};
  assert.equal(await p.publish({event_id:'e1',atom_id:'a1',model:'atom://thing',operation:'create',version:1,payload}),1);
  assert.equal(sent.format,'JSONEachRow');
  assert.equal(JSON.parse(sent.values[0].payload).attr.a,1);
  assert.deepEqual(payload,{attr:{a:1}});
});
test('rejects unsafe table names and incomplete events', async () => {
  assert.throws(()=>createClickHouseProjector({client:{insert(){}},table:'x;DROP'}));
  await assert.rejects(()=>createClickHouseProjector({client:{insert(){}}}).publish({atom_id:'x'}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnowflakeAdapter} from './snowflake-adapter.mjs';
import {validateAnalyticalAdapter} from './analytical-adapter.mjs';
test('Snowflake adapter uses binds and preserves payload',async()=>{
 const calls=[];
 const adapter=validateAnalyticalAdapter(createSnowflakeAdapter({client:{execute:async args=>{calls.push(args);return {rows:[{EVENT_ID:'e1'}]};}}}));
 assert.equal(await adapter.publish({event_id:'e1',atom_id:'a1',model:'atom://person',operation:'create',version:1,payload:{x:1}}),1);
 assert.deepEqual(JSON.parse(calls[0].binds[6]),{x:1});
 assert.deepEqual(await adapter.history("a' OR 1=1"),[{EVENT_ID:'e1'}]);
 assert.equal(calls[1].binds[0],"a' OR 1=1");
});
test('rejects table injection and invalid events',async()=>{
 assert.throws(()=>createSnowflakeAdapter({client:{execute(){}},table:'X;DROP'}));
 const a=createSnowflakeAdapter({client:{execute(){} }});
 await assert.rejects(()=>a.publish({atom_id:'x'}));
});

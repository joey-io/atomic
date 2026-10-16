import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectionWorker} from './projection-worker.mjs';
test('acks only after all projectors succeed; retries same event id',async()=>{
 const rows=[{event_id:'e1'}],calls=[];let fail=true;
 const outbox={pending:async()=>rows.slice(),acknowledge:async ids=>{calls.push('ack');rows.shift();}};
 const worker=createProjectionWorker({outbox,projectors:[
  {publish:async e=>calls.push(e.event_id)},
  {publish:async e=>{if(fail)throw Error('offline');calls.push('second');}}
 ]});
 await assert.rejects(()=>worker.drain(),/offline/);
 assert.equal(rows.length,1);
 fail=false;assert.equal(await worker.drain(),1);
 assert.deepEqual(calls,['e1','e1','second','ack']);
});

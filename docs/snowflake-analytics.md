# Snowflake and ClickHouse analytical adapters

Atomic keeps **canonical records in PostgreSQL/SQLite**. Analytics are optional,
eventually consistent projections. Use a transactional outbox to publish committed
events with stable `event_id`; retries may create duplicate analytical rows.
Consumers must deduplicate and reconcile. Neither analytical backend enforces
canonical identity, authorization, or transactional lifecycle semantics.

The shared adapter contract in `src/analytical-adapter.mjs` is:
`publish(events)` and `history(atomId,{limit})`. ClickHouse currently supplies
a projection-only transport; its history query lives in Atomic Reason. Snowflake
supplies both operations in `src/snowflake-adapter.mjs`. This is a first-stage
interface, not complete cross-database federation.

Snowflake usage (provide an async promise-based wrapper around the official
driver's callback API):

```js
import {SNOWFLAKE_DDL,createSnowflakeAdapter} from './src/snowflake-adapter.mjs';
const client={execute:({sqlText,binds})=>new Promise((resolve,reject)=>
  connection.execute({sqlText,binds,complete:(err,stmt,rows)=>
    err?reject(err):resolve({rows})}))};
await client.execute({sqlText:SNOWFLAKE_DDL,binds:[]});
const adapter=createSnowflakeAdapter({client});
await adapter.publish({event_id:'outbox-1',atom_id:'a1',model:'atom://person',
 operation:'create',version:1,payload:{attr:{name:'Example'}}});
```

Grant least-privilege access; protect sensitive data before projection and
authorize analytical reads through the canonical ledger. Do not treat missing
analytics as missing evidence. Snowflake ingestion here uses row-by-row inserts
for simplicity; production throughput requires batch or staged ingestion.

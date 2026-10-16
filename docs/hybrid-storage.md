# Hybrid transactional + analytical storage

Atomic remains the **system of record**. Use SQLite or PostgreSQL for canonical atoms,
identity, governance, authorization, and transactional writes. ClickHouse is an optional
**append-only projection**, not a drop-in kernel store.

`src/clickhouse-projection.mjs` exports `CLICKHOUSE_DDL` and
`createClickHouseProjector({client,table})`. Execute the DDL using your ClickHouse
client, then publish committed change events:

```js
import {createClickHouseProjector} from './src/clickhouse-projection.mjs';
const projector=createClickHouseProjector({client});
await projector.publish({
  event_id:'outbox-123',atom_id:'atom-123',model:'atom://person',
  operation:'update',version:2,recorded_at:new Date().toISOString(),
  payload:{attr:{name:'Example'}}
});
```

**Integration contract:** Commit the canonical write and an outbox event in the
same transactional database transaction. A separate worker reads the outbox,
publishes to ClickHouse, and acknowledges only after a successful insert.
Retry failures. Use stable `event_id` for deduplication; MergeTree does not enforce
unique event IDs. Querying ClickHouse is eventually consistent. Never authorize
reads using ClickHouse alone; apply canonical tenancy and field-level access rules
before publishing and at the query boundary. Avoid exporting sensitive attributes
unless explicitly permitted. Use version and event ID for replay and reconciliation.

This module implements the **projection transport**, not the transactional outbox
worker, query federation, or a complete production deployment. Those require
integration with the chosen canonical backend.

Snowflake alternative: use `src/snowflake-adapter.mjs` and `docs/snowflake-analytics.md`. Both analytical backends are projections, never the canonical transaction store.

// Backend-neutral durable outbox worker. The canonical store must implement
// pending(limit), acknowledge(ids), and atomically enqueue with its canonical write.
// This worker deliberately does not pretend to provide the database transaction.
export function createProjectionWorker({outbox,projectors}) {
 if (!outbox || typeof outbox.pending!=='function' || typeof outbox.acknowledge!=='function')
   throw new TypeError('Durable outbox port required');
 if (!Array.isArray(projectors) || !projectors.length ||
     projectors.some(p=>!p || typeof p.publish!=='function))
   throw new TypeError('At least one analytical projector required');
 return {
  async drain({limit=100}={}) {
   if (!Number.isInteger(limit) || limit<1 || limit>10000) throw new RangeError('Invalid limit');
   const rows=await outbox.pending(limit);
   if (!Array.isArray(rows)) throw new TypeError('Outbox pending must return an array');
   let delivered=0;
   for (const row of rows) {
     if (!row?.event_id) throw new TypeError('Outbox row requires stable event_id');
     // Each backend receives the same stable event ID. A failure leaves this row
     // unacknowledged, so earlier successful backends may see a duplicate on retry.
     for (const projector of projectors) await projector.publish(row);
     await outbox.acknowledge([row.event_id]);
     delivered++;
   }
   return delivered;
  }
 };
}

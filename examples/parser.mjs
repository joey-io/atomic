import { createAtomic } from 'atomic';

const atomic = await createAtomic();

const observation = await atomic.observe(`
  Jane Smith <jane@example.com> reported a shipment delay on July 17, 2026.
`);

console.dir(observation, { depth: null });

// Production applications inject a semantic provider and a sink that writes
// accepted candidates through the Atomic kernel or HTTP API.

# Evidence-first positioning

**Atomic is an evidence ledger, not a database of unquestionable truth.**

Its primary obligation is to preserve what was gathered, how, when, by whom,
from which original source, and under what collection conditions. Agents and
analysts may derive claims and interpretations, but the ledger must retain the
source material and lineage necessary to challenge or reconstruct them.

## Principles

1. **Collection before conclusion.** A source observation is not the same as
   an assertion, and an assertion is not the same as a verified conclusion.
2. **Fidelity before confidence.** Store immutable original bytes or durable
   content-addressed references, capture timestamps, source identifiers,
   extraction versions, and provenance. Hashes verify byte identity, not truth.
3. **Authority is claim-specific.** A roll-call record can establish a recorded
   vote, not the legislator's motivation. No source is globally infallible.
4. **Corroboration requires independence.** A news article and five reposts are
   not six independent sources. Preserve citation and derivation links.
5. **Corrections add history.** Revisions, disputes, and retractions must remain
   reconstructible rather than silently replacing earlier evidence.
6. **Automated collection can be trusted conditionally.** Human review is not
   required for every assertion. Validation policies should depend on source,
   claim type, collection method, and consequences; record decisions and
   uncertainty explicitly.
7. **Reasoning is downstream.** Atomic Reason computes goal-relative coverage,
   conflicts, and supported interpretations. It cannot manufacture reliable
   evidence from weak sources.

## Current implementation boundaries

Atomic provides document extraction, model-driven candidates, identity folding,
governed atom storage, and experimental analytical projection adapters. These do
**not yet** guarantee immutable original artifact retention, source-independence
analysis, fully integrated review policies, transactional outbox persistence, or
end-to-end provenance reconstruction. Treat this as the design contract to test,
not a claim of implemented production guarantees.

## Scale implications

Separate bulk source bytes from canonical metadata and append-only evidence
events. Index by source, entity, time, and claim; partition analytical history.
Use bounded queues, idempotent ingestion, replayable transformations, and
materialized projections. Keep authoritative transactions separate from large
analytical scans. Measure evidence fan-out, graph expansion, query latency,
reconciliation lag, and cost per collection. Enforce tenant and field-level
authorization at every export and query boundary.

# Parser architecture

Atomic exposes a package runtime above the existing kernel:

```text
input
  ↓
adapter / normalization
  ↓
provider observes against loaded model definitions
  ↓
candidates + relationships + evidence
  ↓
confidence gate
  ↓
fold engine
  ├─ normalize identity fields
  ├─ generate deterministic blocking keys
  ├─ retrieve plausible canonical atoms
  ├─ evaluate positive signals and contradictions
  └─ create, merge, or review
  ↓
canonical atoms + immutable observations + assertions
  ↓
fold store / Atomic kernel adapter
```

The **model registry** defines vocabulary, recognition guidance, identity, resolution, and merge policy.

The **provider** may be an LLM, rules engine, local model, or domain service. It proposes structured candidates but does not own identity decisions.

The **observation** preserves the provider's candidate, confidence, evidence, input, and normalized values.

The **fold engine** is deterministic. Model packs define identity keys, exclusive identifiers, thresholds, contextual signals, and field merge policies. The engine records every field assertion so a canonical atom remains explainable and can be re-folded under a later pack version.

The included memory fold store is a reference implementation. A production kernel adapter should map observations, assertions, reviews, merge events, redirects, and canonical atoms into ordinary Atomic models so they inherit tenancy, grants, lifecycle, transactions, and the evidence ledger.

This separation keeps model packs portable and commercially distributable while preventing any model vendor, document format, or persistence driver from becoming part of the ontology.

See [`folding.md`](./folding.md) for the complete mechanism.

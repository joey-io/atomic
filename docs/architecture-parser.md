# Parser architecture

```text
input adapter -> provider -> observation -> confidence policy -> sink -> Atomic atoms
                       ^
                       |
                 resolved model registry
```

- The **model registry** defines the vocabulary and recognition guidance.
- The **provider** performs deterministic, AI-backed, or hybrid observation.
- The **observation** is immutable evidence: candidates, relationships, confidence, and provenance.
- The **confidence policy** separates automatic persistence from human review.
- The **sink** controls how accepted candidates become atoms.
- The existing **Atomic kernel** remains the authoritative ledger, authorization, lifecycle, and query surface.

This separation keeps model packs portable and commercially distributable while preventing any model vendor, document format, or persistence driver from becoming part of the ontology.

# Changelog

## 0.3.0

- Add the zero-dependency `atomic` executable.
- Add `observe`, `parse`, `resolve`, `fold`, and `models` commands.
- Support files and stdin, pretty JSON, JSON Lines, provider instructions, and operation context.
- Support config modules, repeatable model-pack loading, and project model-directory overrides.
- Add CLI documentation and black-box command tests.

## 0.2.0

- Add deterministic identity folding between parsing and canonical persistence.
- Add immutable observations and field-level assertions with provenance.
- Add model-defined identity keys, definitive/exclusive identifiers, contextual signals, contradiction penalties, and review thresholds.
- Add confidence, recency, source-priority, union, and never-overwrite field merge policies.
- Add merge events, redirects, manual merges, and reversible splits.
- Add a fold-store contract and in-memory reference implementation.
- Integrate `resolve()`, `fold()`, `merge()`, and `split()` into the public package runtime.

## 0.1.0

- Publish Atomic as an importable Node.js package.
- Add the model-pack v1 format and JSON Schema.
- Ship built-in `person`, `place`, `thing`, and `event` models.
- Add model inheritance, package loading, project autoloading, and deterministic override order.
- Add `observe()`, `parse()`, and `parseStream()` APIs.
- Add provider and persistence-sink contracts.
- Add confidence-based accept, review, and reject workflows.
- Add parser tests, documentation, and an executable example.

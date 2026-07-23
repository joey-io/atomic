# Changelog

## 0.4.0

- Add first-class document and document-extraction models.
- Extract text directly from text, JSON, XML, HTML, PDF, and DOCX inputs.
- Prefer PDF text extraction and fall back to OCR through optional Poppler and Tesseract tools.
- Add custom extractor hooks for other document and image formats.
- Compile loaded model definitions into semantic extraction contracts.
- Add strict evidence, schema, type, confidence, and relationship validation for AI output.
- Add a generic semantic provider and an OpenAI-compatible HTTP provider.
- Preserve source hashes, extraction metadata, page locations, and exact evidence excerpts.
- Wire document ingestion and semantic extraction through the package API and CLI.
- Add semantic-provider and document-ingestion tests.

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

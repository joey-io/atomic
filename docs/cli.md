# Atomic CLI

The `atomic` package installs a zero-dependency command-line interface alongside the Node.js API.

```bash
npm install atomic
atomic help
```

The CLI uses the same model registry, provider contract, confidence policy, and fold engine as `createAtomic()`.

## Commands

### Observe

Extract candidates without folding or changing canonical data.

```bash
atomic observe ./notes.txt --pretty
cat message.txt | atomic observe - --pretty
```

### Parse

Observe an input and fold accepted candidates into canonical data.

```bash
atomic parse ./report.txt --pretty
atomic parse ./report.txt --no-persist --pretty
atomic parse ./report.txt --accept-all --pretty
```

`--no-persist` performs observation and confidence classification without folding. `--accept-all` accepts every candidate at or above the review threshold.

### Resolve

Explain how one candidate compares with existing canonical atoms. Input is JSON from a file or stdin.

```bash
atomic resolve ./candidate.json --pretty
cat candidate.json | atomic resolve - --pretty
```

### Fold

Create, merge, or queue one candidate for review.

```bash
atomic fold ./candidate.json --pretty
```

### Models

List the loaded model registry or inspect a resolved definition.

```bash
atomic models --pretty
atomic models person --pretty
```

## Model loading

Atomic loads definitions in this order:

1. built-in core models
2. model packs supplied with `--model`
3. project models from `atomic/models`, or the directory supplied with `--model-dir`

Later definitions override earlier definitions.

```bash
atomic models \
  --model @atomic/models-public-affairs \
  --model ./packs/project.mjs \
  --model-dir ./atomic/models \
  --pretty
```

Use `--no-model-dir` to disable project autoloading.

## Configuration

A config module can provide any `createAtomic()` option, including an AI provider, durable fold store, model packs, normalizers, and resolution thresholds.

```js
// atomic.config.mjs
import publicAffairs from '@atomic/models-public-affairs';
import provider from './provider.mjs';
import foldStore from './fold-store.mjs';

export default {
  models: [publicAffairs],
  provider,
  foldStore,
  thresholds: {
    persist: 0.9,
    review: 0.65
  },
  resolution: {
    autoMergeScore: 120,
    reviewScore: 45,
    requireStrongForAutoMerge: true
  }
};
```

```bash
atomic parse ./inbox/message.txt --config ./atomic.config.mjs --pretty
```

CLI flags extend or override the corresponding config values. `--model` is repeatable and appends model packs to those supplied by the config.

## Context and provider instructions

```bash
atomic observe ./document.txt \
  --instructions 'Treat committee ids as definitive identifiers.' \
  --context '{"tenant":"acme","sourcePriority":80}' \
  --pretty
```

`--context` must be valid JSON.

## Output

All commands write JSON to stdout and machine-readable errors to stderr. A failed command exits nonzero.

- `--pretty` formats JSON with indentation.
- `--jsonl` emits top-level arrays as one JSON object per line.

This makes the CLI composable with shell pipelines and tools such as `jq`.

```bash
atomic models --jsonl | jq -r '.name'
```

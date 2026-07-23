import { createAtomic as createParserRuntime } from './index.mjs';
import { createFoldEngine, createMemoryFoldStore } from './fold.mjs';

export * from './index.mjs';
export * from './fold.mjs';

/**
 * Create the public Atomic package runtime.
 *
 * Parsing is deliberately two-phase: observe proposes candidates; fold resolves
 * those candidates against the canonical graph. A custom durable fold store may
 * be supplied without coupling the parser to the HTTP kernel or an AI vendor.
 */
export async function createAtomic(options = {}) {
  const parser = await createParserRuntime(options);
  const externalSink = options.sink;
  const foldStore = options.foldStore ?? (isFoldStore(externalSink) ? externalSink : createMemoryFoldStore());
  const foldEngine = createFoldEngine({
    registry: parser.models,
    store: foldStore,
    normalizers: options.normalizers,
    policy: options.resolution
  });
  const thresholds = parser.config.thresholds;

  async function observe(input, observeOptions = {}) {
    return parser.observe(input, observeOptions);
  }

  async function resolve(candidate, context = {}) {
    return foldEngine.resolve(candidate, context);
  }

  async function fold(candidate, context = {}) {
    return foldEngine.fold(candidate, context);
  }

  async function parse(input, parseOptions = {}) {
    const observation = await observe(input, parseOptions);
    const accepted = observation.candidates.filter(candidate => accepts(candidate, observation, parseOptions, thresholds));
    const review = observation.candidates.filter(candidate => candidate.confidence >= thresholds.review && !accepted.includes(candidate));
    const rejected = observation.candidates.filter(candidate => candidate.confidence < thresholds.review);

    if (parseOptions.persist === false) {
      return { ...observation, accepted, review, rejected, folds: [], persisted: [] };
    }

    const folds = await foldEngine.foldObservation({ ...observation, candidates: accepted });
    const persisted = folds.map(result => result.atom);

    // Optional projection into another persistence boundary. The fold store is
    // authoritative for identity decisions; a sink may mirror those decisions
    // into the Atomic kernel, a database, or an event stream.
    if (externalSink && externalSink !== foldStore) {
      if (typeof externalSink.persistFold === 'function') {
        await externalSink.persistFold({ observation, folds });
      } else if (typeof externalSink.persist === 'function') {
        await externalSink.persist({ ...observation, candidates: accepted, folds });
      }
    }

    return { ...observation, accepted, review, rejected, folds, persisted };
  }

  async function* parseStream(input, parseOptions = {}) {
    yield { type: 'parse.started' };
    const observation = await observe(input, parseOptions);
    yield { type: 'observation.completed', data: observation };
    for (const candidate of observation.candidates) yield { type: 'candidate.detected', data: candidate };

    const accepted = observation.candidates.filter(candidate => accepts(candidate, observation, parseOptions, thresholds));
    const review = observation.candidates.filter(candidate => candidate.confidence >= thresholds.review && !accepted.includes(candidate));
    const rejected = observation.candidates.filter(candidate => candidate.confidence < thresholds.review);
    const folds = [];

    if (parseOptions.persist !== false) {
      for (const candidate of accepted) {
        const result = await foldEngine.fold(candidate, observation);
        folds.push(result);
        yield { type: `fold.${result.action}`, data: result };
      }
    }

    const result = { ...observation, accepted, review, rejected, folds, persisted: folds.map(item => item.atom) };
    yield { type: 'parse.completed', data: result };
  }

  return {
    ...parser,
    observe,
    resolve,
    fold,
    parse,
    parseStream,
    merge: foldEngine.merge,
    split: foldEngine.split,
    foldStore,
    sink: options.sink ?? foldStore,
    config: {
      ...parser.config,
      resolution: {
        autoMergeScore: options.resolution?.autoMergeScore ?? 120,
        reviewScore: options.resolution?.reviewScore ?? 45,
        requireStrongForAutoMerge: options.resolution?.requireStrongForAutoMerge ?? true
      }
    }
  };
}

function accepts(candidate, observation, options, thresholds) {
  if (options.accept === 'all') return candidate.confidence >= thresholds.review;
  if (typeof options.accept === 'function') return options.accept(candidate, observation);
  return candidate.confidence >= thresholds.persist;
}

function isFoldStore(value) {
  return value && [
    'findByIdentityKeys',
    'createCanonical',
    'updateCanonical',
    'recordObservation',
    'recordMerge'
  ].every(method => typeof value[method] === 'function');
}

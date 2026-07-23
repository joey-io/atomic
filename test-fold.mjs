import assert from 'node:assert/strict';
import {
  ModelRegistry,
  createAtomic,
  createFoldEngine,
  createMemoryFoldStore,
  defineModelPack,
  identityKeys
} from './src/package.mjs';

const store = createMemoryFoldStore();
const registry = new ModelRegistry();
const engine = createFoldEngine({ registry, store });

const first = await engine.fold({
  candidateId: 'candidate-1',
  model: 'person',
  attributes: { name: 'Jane Smith', email: 'Jane@Example.com' },
  confidence: 0.97,
  evidence: [{ source: 'one.txt', excerpt: 'Jane Smith <Jane@Example.com>' }]
}, { observationId: 'one', provider: 'test' });

assert.equal(first.action, 'create');
assert.equal(store.list().length, 1);
assert.equal(first.atom.attr.email, 'jane@example.com');

const second = await engine.fold({
  candidateId: 'candidate-2',
  model: 'person',
  attributes: { name: 'J. Smith', email: 'jane@example.com', title: 'Director' },
  confidence: 0.94,
  evidence: [{ source: 'two.txt', excerpt: 'J. Smith, Director' }]
}, { observationId: 'two', provider: 'test' });

assert.equal(second.action, 'merge');
assert.equal(second.atom.id, first.atom.id);
assert.equal(store.list().length, 1);
assert.equal(store.listObservations().length, 2);
assert.equal(store.listMerges().length, 1);
assert.equal(second.atom.attr.name, 'jane smith');
assert.equal(second.atom.attr.title, 'director');
assert.equal(second.atom.assertions.filter(item => item.field === 'name').length, 2);

const keysA = identityKeys({ attributes: { email: 'jane@example.com' } }, registry.get('person'));
const keysB = identityKeys({ attributes: { email: 'jane@example.com' } }, registry.get('person'));
assert.equal(keysA[0].hash, keysB[0].hash, 'identity hashes must be deterministic');

const assets = defineModelPack({
  atomic: 1,
  name: '@example/assets',
  version: '1.0.0',
  models: [{
    name: 'asset',
    extends: 'thing',
    description: 'A serialized physical asset.',
    attributes: {
      name: { kind: 'text', required: true },
      serial: { kind: 'text', required: true, merge: { strategy: 'never-overwrite' } },
      site: { kind: 'text' },
      tags: { kind: 'list', merge: { strategy: 'union' } }
    },
    identity: [
      { name: 'serial', fields: ['serial'], strength: 'definitive', exclusive: true },
      { name: 'name-site', fields: ['name', 'site'], strength: 'medium' }
    ],
    resolution: { thresholds: { autoMerge: 100, review: 30 } }
  }]
});

const assetRegistry = new ModelRegistry();
assetRegistry.load(assets);
const assetStore = createMemoryFoldStore();
const assetEngine = createFoldEngine({ registry: assetRegistry, store: assetStore });

const assetA = await assetEngine.fold({ model: 'asset', attributes: { name: 'Pump 1', serial: 'A-100', site: 'Plant A', tags: ['critical'] }, confidence: 0.99 }, { observationId: 'asset-a' });
const assetB = await assetEngine.fold({ model: 'asset', attributes: { name: 'Pump 1', serial: 'B-200', site: 'Plant A', tags: ['inspection'] }, confidence: 0.99 }, { observationId: 'asset-b' });
assert.equal(assetA.action, 'create');
assert.equal(assetB.action, 'review', 'conflicting definitive identifiers must never auto-merge');
assert.equal(assetStore.list().length, 2);
assert.equal(assetStore.listReviews().length, 1);

const parser = await createAtomic({
  modelDirectory: false,
  provider: {
    async observe(request) {
      const alternate = request.input.text.includes('alternate');
      return {
        provider: 'fold-test',
        candidates: [{
          model: 'person',
          attributes: { name: alternate ? 'Joseph Smith' : 'Joe Smith', email: 'joe@example.com' },
          confidence: alternate ? 0.93 : 0.98,
          evidence: [{ source: request.input.name, excerpt: request.input.text }]
        }]
      };
    }
  }
});

const parsedOne = await parser.parse('primary record');
const parsedTwo = await parser.parse('alternate record');
assert.equal(parsedOne.folds[0].action, 'create');
assert.equal(parsedTwo.folds[0].action, 'merge');
assert.equal(parser.foldStore.list().length, 1);
assert.equal(parsedTwo.persisted[0].attr.name, 'joe smith', 'higher-confidence assertion remains canonical');

console.log('fold engine: ok');

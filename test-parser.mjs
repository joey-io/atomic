import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AtomicDefinitionError,
  ModelRegistry,
  coreModelPack,
  createAtomic,
  defineModelPack
} from './src/index.mjs';

const registry = new ModelRegistry();
assert.deepEqual(registry.list().map(model => model.name), ['event', 'person', 'place', 'thing']);
assert.equal(registry.get('person').attributes.name.required, true);
assert.equal(registry.get('person').attributes.description.kind, 'longtext');

const crm = defineModelPack({
  atomic: 1,
  name: '@example/crm',
  version: '1.0.0',
  models: [{
    name: 'person',
    extends: 'thing',
    description: 'A CRM contact.',
    attributes: {
      name: { kind: 'text', required: true },
      accountId: { kind: 'text', required: true }
    },
    observe: { instructions: 'Only extract known CRM contacts.' }
  }, {
    name: 'organization',
    extends: 'thing',
    description: 'A formal or informal organization.',
    attributes: { name: { kind: 'text', required: true } }
  }]
});
registry.load(crm);
assert.equal(registry.get('person').description, 'A CRM contact.');
assert.equal(registry.get('person').attributes.accountId.required, true);
assert.equal(registry.get('person').attributes.description.kind, 'longtext');
assert.equal(registry.source('person'), '@example/crm');

assert.throws(() => new ModelRegistry().load({ atomic: 1, name: 'bad', models: [{ name: 'Bad Name', description: 'x' }] }), AtomicDefinitionError);

const atomic = await createAtomic({
  models: [crm],
  modelDirectory: false,
  provider: {
    name: 'test-provider',
    async observe(request) {
      assert(request.models.some(model => model.name === 'organization'));
      return {
        provider: 'test-provider',
        candidates: [{
          model: 'person',
          attributes: { name: 'Jane Smith', accountId: 'crm-42' },
          confidence: 0.98,
          evidence: [{ source: request.input.name, excerpt: 'Jane Smith' }]
        }],
        relationships: []
      };
    }
  }
});

const preview = await atomic.observe({ name: 'note.txt', text: 'Jane Smith called.' });
assert.equal(preview.candidates[0].model, 'person');
assert.equal(preview.candidates[0].confidence, 0.98);
assert.equal(atomic.sink.list().length, 0);

const parsed = await atomic.parse('Jane Smith called.');
assert.equal(parsed.accepted.length, 1);
assert.equal(parsed.review.length, 0);
assert.equal(parsed.persisted.length, 1);
assert.equal(atomic.sink.list()[0].model, 'atom://person');
assert.equal(atomic.sink.list()[0].evidence[0].excerpt, 'Jane Smith');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-models-'));
await fs.writeFile(path.join(temp, 'project.models.mjs'), `export default ${JSON.stringify({
  atomic: 1,
  name: 'project',
  version: '1.0.0',
  models: [{
    name: 'place',
    extends: 'thing',
    description: 'A project-specific service territory.',
    attributes: { name: { kind: 'text', required: true }, market: { kind: 'text' } }
  }]
})}`);
const projectAtomic = await createAtomic({ modelDirectory: temp });
assert.equal(projectAtomic.models.get('place').description, 'A project-specific service territory.');
assert.equal(projectAtomic.models.get('place').attributes.market.kind, 'text');
assert.equal(projectAtomic.autoloaded.length, 1);
await fs.rm(temp, { recursive: true, force: true });

assert.equal(coreModelPack.name, '@atomic/models-core');
console.log('parser api: ok');

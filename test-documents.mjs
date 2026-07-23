import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDocumentInput, extractText } from './src/documents.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-documents-test-'));
try {
  const file = path.join(directory, 'notes.txt');
  await fs.writeFile(file, 'Joey Smith wrote the memo.');
  const input = await prepareDocumentInput({ path: file });
  assert.equal(input.name, 'notes.txt');
  assert.equal(input.contentType, 'text/plain');
  assert.equal(input.text, 'Joey Smith wrote the memo.');
  assert.equal(input.document.sha256.length, 64);
  assert.equal(input.extraction.method, 'embedded-text');

  const unsupported = await prepareDocumentInput({ name: 'photo.png', contentType: 'image/png', bytes: Buffer.from([1, 2, 3]) });
  assert.equal(unsupported.text, '');
  assert.equal(unsupported.extraction.method, 'unsupported');
  assert.match(unsupported.extraction.warnings[0], /No extractor configured/);

  const custom = await extractText({ name: 'sample.bin', contentType: 'application/x-test', bytes: Buffer.from('x') }, {
    extractors: { 'application/x-test': async () => ({ text: 'custom text', method: 'custom-test', extractor: 'test', extractorVersion: 1 }) }
  });
  assert.equal(custom.text, 'custom text');
  assert.equal(custom.method, 'custom-test');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

console.log('document tests passed');

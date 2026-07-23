import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const cli = path.resolve('bin/atomic.mjs');

const version = await run(['version']);
assert.equal(version.code, 0);
assert.equal(version.stdout.trim(), '0.3.0');

const help = await run(['help']);
assert.equal(help.code, 0);
assert.match(help.stdout, /Atomic CLI 0\.3\.0/);
assert.match(help.stdout, /observe \[file\|-\]/);
assert.match(help.stdout, /models \[name\]/);

const models = await run(['models']);
assert.equal(models.code, 0);
const modelList = JSON.parse(models.stdout);
assert(modelList.some(model => model.name === 'person'));
assert(modelList.some(model => model.name === 'event'));

const person = await run(['models', 'person']);
assert.equal(person.code, 0);
assert.equal(JSON.parse(person.stdout).name, 'person');

const observed = await run(['observe', '-'], 'Jane Smith <jane@example.com> called.');
assert.equal(observed.code, 0, observed.stderr);
const observation = JSON.parse(observed.stdout);
assert.equal(observation.candidates[0].model, 'person');
assert.equal(observation.candidates[0].attributes.email, 'jane@example.com');

const parsed = await run(['parse', '-', '--no-persist'], 'Jane Smith <jane@example.com> called.');
assert.equal(parsed.code, 0, parsed.stderr);
const result = JSON.parse(parsed.stdout);
assert.equal(result.persisted.length, 0);
assert.equal(result.folds.length, 0);

const invalid = await run(['resolve', '-'], '{not-json');
assert.notEqual(invalid.code, 0);
assert.match(invalid.stderr, /Invalid JSON input/);

console.log('cli: ok');

function run(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

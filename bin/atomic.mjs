#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createAtomic } from '../src/package.mjs';

const VERSION = '0.4.0';

main().catch(error => {
  const payload = { error: error.name ?? 'Error', message: error.message, ...(error.details ? { details: error.details } : {}) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === 'help') return printHelp();
  if (flags.version || command === 'version') return process.stdout.write(`${VERSION}\n`);
  const config = await loadConfig(flags.config);
  const modelSources = arrayFlag(flags.model);
  const atomic = await createAtomic({ ...config, models: [...(config.models ?? []), ...modelSources], modelDirectory: flags['model-dir'] === false ? false : flags['model-dir'] ?? config.modelDirectory });
  let result;
  switch (command) {
    case 'observe': result = await atomic.observe(await readInput(positional[0]), operationOptions(flags)); break;
    case 'parse': result = await atomic.parse(await readInput(positional[0]), { ...operationOptions(flags), persist: flags.persist !== false, accept: flags.accept === 'all' ? 'all' : undefined }); break;
    case 'resolve': result = await atomic.resolve(await readJsonInput(positional[0]), operationOptions(flags)); break;
    case 'fold': result = await atomic.fold(await readJsonInput(positional[0]), operationOptions(flags)); break;
    case 'models': {
      const name = positional[0];
      result = name ? atomic.models.get(name) : atomic.models.list().map(model => ({ name: model.name, extends: model.extends, description: model.description, source: atomic.models.source(model.name) }));
      if (name && !result) throw new Error(`Unknown model "${name}"`);
      break;
    }
    default: throw new Error(`Unknown command "${command}". Run atomic help.`);
  }
  writeResult(result, flags);
}

function parseArgs(argv) {
  const args = [...argv];
  let command = 'help';
  if (args[0] && !args[0].startsWith('-')) command = args.shift();
  const positional = [];
  const flags = {};
  while (args.length) {
    const token = args.shift();
    if (token === '--') { positional.push(...args); break; }
    if (!token.startsWith('-') || token === '-') { positional.push(token); continue; }
    if (token === '-h' || token === '--help') { flags.help = true; continue; }
    if (token === '-v' || token === '--version') { flags.version = true; continue; }
    if (token === '--pretty') { flags.pretty = true; continue; }
    if (token === '--jsonl') { flags.jsonl = true; continue; }
    if (token === '--no-persist') { flags.persist = false; continue; }
    if (token === '--no-model-dir') { flags['model-dir'] = false; continue; }
    if (token === '--accept-all') { flags.accept = 'all'; continue; }
    const match = token.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown option "${token}"`);
    const [, key, inline] = match;
    const value = inline ?? args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${key} requires a value`);
    if (key === 'model') flags.model = [...arrayFlag(flags.model), value]; else flags[key] = value;
  }
  return { command, positional, flags };
}

async function loadConfig(specifier) {
  if (!specifier) return {};
  const target = specifier.startsWith('.') || specifier.startsWith('/') ? pathToFileURL(path.resolve(specifier)).href : specifier;
  const module = await import(target);
  const config = module.default ?? module.config ?? module;
  if (!config || typeof config !== 'object') throw new Error('Atomic CLI config must export an object');
  return config;
}

async function readInput(file) {
  if (!file || file === '-') { const bytes = await readStdin(); return { name: 'stdin.txt', contentType: 'text/plain', text: bytes.toString('utf8') }; }
  return { path: path.resolve(file) };
}

async function readJsonInput(file) {
  const bytes = !file || file === '-' ? await readStdin() : await fs.readFile(path.resolve(file));
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`Invalid JSON input: ${error.message}`); }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) throw new Error('No input provided. Pass a file path or pipe data on stdin.');
  return Buffer.concat(chunks);
}

function operationOptions(flags) {
  let context = {};
  if (flags.context) { try { context = JSON.parse(flags.context); } catch (error) { throw new Error(`--context must be JSON: ${error.message}`); } }
  return { instructions: flags.instructions, context };
}

function writeResult(result, flags) {
  if (flags.jsonl && Array.isArray(result)) { for (const item of result) process.stdout.write(`${JSON.stringify(item)}\n`); return; }
  process.stdout.write(`${JSON.stringify(result, null, flags.pretty ? 2 : 0)}\n`);
}

function arrayFlag(value) { if (value === undefined) return []; return Array.isArray(value) ? value : [value]; }

function printHelp() {
  process.stdout.write(`Atomic CLI ${VERSION}\n\nUsage:\n  atomic <command> [input] [options]\n\nCommands:\n  observe [file|-]       Extract evidence-backed candidates from text, PDF, DOCX, or configured formats\n  parse [file|-]         Extract, resolve identity, and fold accepted candidates\n  resolve [json|-]       Explain how one candidate matches existing canonical atoms\n  fold [json|-]          Create, merge, or queue one candidate for review\n  models [name]          List loaded models or print one resolved definition\n  help                   Show this help\n  version                Print the CLI version\n\nOptions:\n  --config <module>      Load an ESM config exporting createAtomic options\n  --model <module>       Load a model pack; repeatable\n  --model-dir <dir>      Autoload project model packs from a directory\n  --no-model-dir         Disable project model autoloading\n  --instructions <text> Add semantic provider instructions\n  --context <json>       Add operation context\n  --accept-all           Parse every candidate at or above the review threshold\n  --no-persist           Parse without folding or persistence\n  --pretty               Pretty-print JSON\n  --jsonl                Emit top-level arrays as JSON Lines\n  -h, --help             Show help\n  -v, --version          Print version\n\nExamples:\n  atomic observe ./meeting.pdf --pretty\n  atomic parse ./contacts.docx --config ./atomic.config.mjs --pretty\n  cat message.txt | atomic parse - --pretty\n  atomic models person --pretty\n`);
}

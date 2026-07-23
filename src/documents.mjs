import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function prepareDocumentInput(input, options = {}) {
  const source = await readSource(input);
  const sha256 = createHash('sha256').update(source.bytes).digest('hex');
  const extraction = await extractText(source, options);
  return {
    ...source.extra,
    name: source.name,
    path: source.path,
    contentType: source.contentType,
    bytes: source.bytes,
    text: extraction.text,
    pages: extraction.pages,
    document: {
      sha256,
      size: source.bytes.length,
      name: source.name,
      path: source.path,
      contentType: source.contentType
    },
    extraction: {
      method: extraction.method,
      extractor: extraction.extractor,
      extractorVersion: extraction.extractorVersion,
      warnings: extraction.warnings ?? []
    }
  };
}

export async function extractText(source, options = {}) {
  const custom = options.extractors?.[source.contentType] ?? options.extractors?.[path.extname(source.name).toLowerCase()];
  if (custom) return normalizeExtraction(await custom(source), 'custom');

  if (source.contentType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(source.contentType)) {
    return { text: source.bytes.toString(options.encoding ?? 'utf8'), method: 'embedded-text', extractor: 'atomic:text', extractorVersion: 1, pages: [] };
  }
  if (source.contentType === 'text/html' || /\.html?$/i.test(source.name)) {
    return { text: htmlToText(source.bytes.toString('utf8')), method: 'html-text', extractor: 'atomic:html', extractorVersion: 1, pages: [] };
  }
  if (source.contentType === 'application/pdf' || /\.pdf$/i.test(source.name)) return extractPdf(source, options);
  if (source.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(source.name)) return extractDocx(source, options);

  return { text: '', method: 'unsupported', extractor: 'atomic:none', extractorVersion: 1, pages: [], warnings: [`No extractor configured for ${source.contentType}`] };
}

async function extractPdf(source, options) {
  const embedded = printablePdfText(source.bytes);
  if (embedded.trim().length >= (options.minimumEmbeddedText ?? 80)) {
    return { text: embedded, method: 'pdf-embedded-text', extractor: 'atomic:pdf-fallback', extractorVersion: 1, pages: splitFormFeed(embedded) };
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-pdf-'));
  const input = path.join(temp, 'input.pdf');
  const output = path.join(temp, 'output.txt');
  try {
    await fs.writeFile(input, source.bytes);
    try {
      await run(options, 'pdftotext', ['-layout', input, output]);
      const text = await fs.readFile(output, 'utf8');
      if (text.trim()) return { text, method: 'pdf-text', extractor: 'pdftotext', extractorVersion: 1, pages: splitFormFeed(text) };
    } catch (error) {
      if (options.ocr === false) return failedExtraction('PDF has no usable text layer and OCR is disabled.', error);
    }
    if (options.ocr === false) return failedExtraction('PDF has no usable text layer and OCR is disabled.');
    const prefix = path.join(temp, 'page');
    await run(options, 'pdftoppm', ['-png', '-r', String(options.ocrDpi ?? 200), input, prefix]);
    const images = (await fs.readdir(temp)).filter(file => /^page-\d+\.png$/.test(file)).sort(naturalSort);
    const pages = [];
    for (const [index, image] of images.entries()) {
      const base = path.join(temp, `ocr-${index + 1}`);
      await run(options, 'tesseract', [path.join(temp, image), base, '-l', options.ocrLanguage ?? 'eng']);
      const text = await fs.readFile(`${base}.txt`, 'utf8');
      pages.push({ page: index + 1, text });
    }
    return { text: pages.map(page => page.text).join('\n\f\n'), method: 'ocr', extractor: 'pdftoppm+tesseract', extractorVersion: 1, pages };
  } catch (error) {
    if (options.requireText) throw new Error(`Unable to extract PDF text: ${error.message}`);
    return failedExtraction('Unable to extract PDF text. Install poppler (pdftotext/pdftoppm) and tesseract, or configure a custom PDF extractor.', error);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function extractDocx(source, options) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-docx-'));
  const input = path.join(temp, 'input.docx');
  try {
    await fs.writeFile(input, source.bytes);
    const { stdout } = await run(options, 'unzip', ['-p', input, 'word/document.xml']);
    return { text: xmlToText(stdout), method: 'docx-xml', extractor: 'unzip', extractorVersion: 1, pages: [] };
  } catch (error) {
    if (options.requireText) throw new Error(`Unable to extract DOCX text: ${error.message}`);
    return failedExtraction('Unable to extract DOCX text. Install unzip or configure a custom DOCX extractor.', error);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function readSource(input) {
  if (typeof input === 'string') return { name: 'inline.txt', contentType: 'text/plain', bytes: Buffer.from(input), extra: {} };
  if (Buffer.isBuffer(input)) return { name: 'buffer.bin', contentType: 'application/octet-stream', bytes: input, extra: {} };
  if (!input || typeof input !== 'object') throw new TypeError('Atomic input must be a string, Buffer, or input object');
  if (input.path) {
    const filePath = path.resolve(input.path);
    const bytes = await fs.readFile(filePath);
    return { name: input.name ?? path.basename(filePath), path: filePath, contentType: input.contentType ?? contentTypeFor(filePath), bytes, extra: withoutPayload(input) };
  }
  if (typeof input.text === 'string') return { name: input.name ?? 'inline.txt', contentType: input.contentType ?? 'text/plain', bytes: Buffer.from(input.text), extra: withoutPayload(input) };
  if (input.bytes) return { name: input.name ?? 'input.bin', contentType: input.contentType ?? 'application/octet-stream', bytes: Buffer.from(input.bytes), extra: withoutPayload(input) };
  throw new TypeError('Input object requires text, bytes, or path');
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml',
    '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })[ext] ?? 'application/octet-stream';
}

function printablePdfText(bytes) {
  const raw = bytes.toString('latin1');
  return [...raw.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)].map(match => match[1].replace(/\\([()\\])/g, '$1')).join('\n');
}

function htmlToText(value) { return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function xmlToText(value) { return decodeEntities(String(value).replace(/<w:tab\/?\s*>/g, '\t').replace(/<w:br\/?\s*>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim(); }
function decodeEntities(value) { return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function splitFormFeed(text) { return text.split('\f').map((pageText, index) => ({ page: index + 1, text: pageText.trim() })).filter(page => page.text); }
function normalizeExtraction(value, fallback) { return typeof value === 'string' ? { text: value, method: fallback, extractor: 'custom', extractorVersion: 1, pages: [] } : { pages: [], ...value }; }
function failedExtraction(message, error) { return { text: '', method: 'failed', extractor: 'atomic:none', extractorVersion: 1, pages: [], warnings: [message, ...(error ? [error.message] : [])] }; }
function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }
function withoutPayload(input) { const { path: _path, text: _text, bytes: _bytes, ...rest } = input; return rest; }
async function run(options, command, args) { return options.commandRunner ? options.commandRunner(command, args) : execFileAsync(command, args, { maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024 }); }

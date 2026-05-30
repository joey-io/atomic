import { model } from './_lib.mjs';

// A stored file: metadata plus the bytes (base64 in `data`).
export default model('file', 'File', {
  name: { kind: 'text' },
  contentType: { kind: 'text' },
  size: { kind: 'integer' },
  data: { kind: 'longtext' },
});

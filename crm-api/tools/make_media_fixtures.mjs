/**
 * Generates fixtures for media from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_media_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const KINDS_MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/media/media-kinds.js'),
).href;

const STORAGE_MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/media/media-storage.service.js'),
).href;

const {
  isInlineSafeMediaType,
  resolveMediaFormat,
  sniffMediaSignature,
  toSafeFileName,
  baseMimeType,
  ACCEPTED_MEDIA_FORMATS,
} = await import(KINDS_MODULE);

const { isValidMediaObjectKey, mediaObjectKeyBelongsTo } = await import(STORAGE_MODULE);

const SAFE_FILENAME_CASES = [
  { raw: '../../etc/passwd', ext: '.txt' },
  { raw: 'C:\\Users\\x\\secret.pdf', ext: '.pdf' },
  { raw: 'a"weird\'name.pdf', ext: '.pdf' },
  { raw: '', ext: '.pdf' },
  { raw: '///', ext: '.pdf' },
  { raw: 'a'.repeat(400), ext: '.pdf' },
  { raw: 'normal_file.jpg', ext: '.jpg' },
  { raw: 'invoice.pdf.exe', ext: '.pdf' },
  { raw: 'hello \t world \n test', ext: '.txt' },
  { raw: 'file<with>bad*chars?.doc', ext: '.doc' },
];

const safeFileNameResults = SAFE_FILENAME_CASES.map(c => ({
  input: c,
  output: toSafeFileName(c.raw, c.ext),
}));

const INLINE_SAFE_CASES = [
  'image/png',
  'image/jpeg',
  'video/mp4',
  'audio/ogg',
  'audio/mpeg',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/octet-stream',
  null,
  '',
  'audio/webm;codecs=opus',
];

const inlineSafeResults = INLINE_SAFE_CASES.map(mime => ({
  input: mime,
  output: isInlineSafeMediaType(mime),
}));

const KEY_CASES = [
  '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/12345678-1234-1234-1234-123456789abc.jpg',
  '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/12345678-1234-1234-1234-123456789abc.png',
  '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/12345678-1234-1234-1234-123456789abc.docx',
  '../../etc/passwd',
  '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/not-a-uuid.jpg',
  '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/12345678-1234-1234-1234-123456789abc',
  '',
  null,
];

const keyResults = KEY_CASES.map(k => ({
  input: k,
  valid: isValidMediaObjectKey(k),
  belongsTo: k ? mediaObjectKeyBelongsTo({
    objectKey: k,
    organizationId: '507f1f77bcf86cd799439011',
    conversationId: '507f1f77bcf86cd799439012',
  }) : false,
}));

const out = {
  safeFileName: safeFileNameResults,
  inlineSafe: inlineSafeResults,
  keyValidation: keyResults,
};

const target = path.resolve(process.cwd(), 'tests/fixtures/media.json');
writeFileSync(target, JSON.stringify(out, null, 2), 'utf-8');
console.log(`Wrote media fixtures to ${target}`);


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { inspectPhoto, verifyCatalogPhotos } from '../utils/catalogMedia.js';

const file = new URL('../catalog/source-assets/M06/tiago-1.jpg', import.meta.url);
const bytes = await readFile(file);
const response = (body = bytes) => new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
test('real licensed source photograph is decoded, measured and fingerprinted without certifying identity automatically', async () => {
  const result = await inspectPhoto('https://example.test/photo.jpg', { decoder: sharp, fetcher: async () => response() });
  assert.equal(result.evidence.width, 4752);
  assert.equal(result.evidence.height, 3168);
  assert.equal(result.evidence.sha256, '307f95186324784a9cd41a558780daf54c77f9b71ecdd7bba06f4e05311a969e');
  assert.equal(result.evidence.decoded, true);
  assert.equal(result.evidence.matchApproved, undefined);
  assert.equal(result.evidence.rightsApproved, undefined);
});

test('photo checker rejects broken URLs, HTML, low-resolution files and oversized responses', async () => {
  await assert.rejects(inspectPhoto('http://example.test/a.jpg', { decoder: sharp }), /HTTPS/);
  await assert.rejects(inspectPhoto('https://example.test/a.jpg', { decoder: sharp,
    fetcher: async () => new Response('Not found', { status: 404 }) }), /404/);
  await assert.rejects(inspectPhoto('https://example.test/a.jpg', { decoder: sharp,
    fetcher: async () => response('<html>not a photograph</html>') }));
  // A downscaled test derivative is created in memory only, never in the catalog.
  const lowResolution = await sharp(bytes).resize(400).jpeg().toBuffer();
  await assert.rejects(inspectPhoto('https://example.test/a.jpg', { decoder: sharp,
    fetcher: async () => response(lowResolution) }), /Resolution/);
  await assert.rejects(inspectPhoto('https://example.test/a.jpg', { decoder: sharp,
    fetcher: async () => new Response('', { headers: { 'content-length': String(21 * 1024 * 1024) } }) }), /20 MB/);
});

test('fresh content verification detects a changed source image', async () => {
  const catalog = { records: [{ key: 'M06', media: [{ url: 'https://example.test/a.jpg', sha256: 'wrong' }] }] };
  await assert.rejects(verifyCatalogPhotos(catalog, { decoder: sharp, fetcher: async () => response() }), /content changed/);
});

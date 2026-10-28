// Image/gallery checks only: no environment loader, database connection or import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sharp from 'sharp';
import { verifyPreviewAssets } from '../utils/catalogMedia.js';
import { validateCatalog, validateTemporarySample, readiness, digest } from '../utils/catalogImport.js';

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const catalog = await load('../catalog/mumbai-15x15.json');
const original = await load('../catalog/mumbai-2026.json');
const references = await load('../catalog/reference-galleries.json');
const vehicles = ['M01', 'M03', 'M10', 'M15', 'M17'];
const properties = ['P01', 'P03', 'P07', 'P11', 'P14'];

test('reference integration preserves every original listing field and all other media', () => {
  assert.equal(validateCatalog(catalog).total, 30);
  for (const row of catalog.records) {
    const before = original.records.find(item => item.key === row.key);
    assert.deepEqual(row.listing, before.listing, row.key);
    if (!vehicles.includes(row.key)) assert.deepEqual(row.media, before.media, row.key);
  }
  for (const key of properties) {
    const row = catalog.records.find(item => item.key === key);
    assert.equal(row.media.length, 0);
    assert.equal(row.previewGallery.length, 3);
    assert.ok(row.previewGallery.every(asset => asset.kind === 'placeholder'));
  }
});

test('five complete galleries retain rights, model/set evidence and existing import safeguards', async () => {
  assert.ok(vehicles.every(key => references[key]));
  const checks = readiness(catalog);
  for (const key of vehicles) {
    const row = catalog.records.find(item => item.key === key);
    assert.deepEqual(row.media, references[key].media);
    assert.deepEqual(row.previewGallery, references[key].previewGallery);
    assert.equal(row.media.length, 2);
    assert.equal(new Set(row.media.map(photo => photo.setId)).size, 1);
    assert.equal(new Set(row.media.map(photo => photo.angle)).size, 2);
    for (const photo of row.media) {
      assert.match(photo.attribution, /Reference Photos — Demo\/Sample Listing/);
      assert.match(photo.sourcePage, /^https:\/\/commons.wikimedia.org\/wiki\/File:/);
      assert.match(photo.licenseUrl, /^https:\/\/creativecommons.org\/licenses\/by-sa\//);
      assert.equal(photo.rightsApproved, true);
      assert.equal(photo.matchApproved, true);
      assert.ok(photo.identityEvidence && photo.licenseEvidence);
    }
    assert.deepEqual(checks.find(row => row.key === key).blockers,
      ['owner assignment pending', 'details/physical identity not approved']);
  }
  validateTemporarySample(catalog);
  await verifyPreviewAssets(catalog);
  const receipt = await load('../catalog/owner-approvals-15x15.example.json');
  assert.equal(receipt.approved, false);
  assert.equal(receipt.manifestSha256, digest(catalog));
  assert.ok(Object.values(receipt.assignments).every(assignment => assignment.approved === false));
});

test('all ten public photographs load as distinct decoded JPEGs with public attribution', async () => {
  const app = express();
  app.use('/catalog-media', express.static(fileURLToPath(new URL('../../public/catalog-media/', import.meta.url))));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hashes = new Set();
    for (const key of vehicles) {
      const row = catalog.records.find(item => item.key === key);
      const credits = await fetch(`${origin}/catalog-media/${key}/ATTRIBUTION.md`);
      assert.equal(credits.status, 200);
      const text = await credits.text();
      for (const [index, asset] of row.previewGallery.entries()) {
        const response = await fetch(origin + asset.url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /image\/jpeg/);
        const bytes = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.format, 'jpeg');
        assert.ok(metadata.width >= 1600 && metadata.height >= 900);
        const hash = createHash('sha256').update(bytes).digest('hex');
        assert.equal(hash, asset.sha256);
        assert.equal(hashes.has(hash), false); hashes.add(hash);
        assert.ok(text.includes(row.media[index].sourcePage));
        assert.ok(text.includes(row.media[index].licenseUrl));
      }
    }
    assert.equal(hashes.size, 10);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

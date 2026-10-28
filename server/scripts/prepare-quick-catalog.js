import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { QUICK_KEYS, QUICK_PROFILE } from '../catalog/quickSelection.js';
import { validateCatalog, digest } from '../utils/catalogImport.js';

const full = JSON.parse(await readFile(new URL('../catalog/mumbai-2026.json', import.meta.url), 'utf8'));
validateCatalog(full);
const records = QUICK_KEYS.map(key => structuredClone(full.records.find(row => row.key === key)));
// Retain separately reviewed reference galleries when regenerating the selection.
const referenceGalleries = JSON.parse(await readFile(new URL('../catalog/reference-galleries.json', import.meta.url), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
}));
const publicDirectory = new URL('../../public/catalog-placeholders/', import.meta.url);
await mkdir(publicDirectory, { recursive: true });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const record of records) {
  const reference = referenceGalleries[record.key];
  if (reference && record.listing.type === 'vehicle') {
    record.media = reference.media;
    record.previewGallery = reference.previewGallery;
    record.approval.media = 'approved';
    continue;
  }
  record.previewGallery = [];
  if (record.media.length >= 2 && record.listing.type === 'vehicle') {
    const directory = new URL(`../../public/catalog-media/${record.key}/`, import.meta.url);
    await mkdir(directory, { recursive: true });
    for (const [index] of record.media.entries()) await copyFile(
      new URL(`../catalog/source-assets/${record.key}/tiago-${index + 1}.jpg`, import.meta.url), new URL(`tiago-${index + 1}.jpg`, directory));
    await copyFile(new URL(`../catalog/source-assets/${record.key}/ATTRIBUTION.md`, import.meta.url), new URL('ATTRIBUTION.md', directory));
    record.previewGallery = record.media.map((photo, index) => ({
      url: `/catalog-media/${record.key}/tiago-${index + 1}.jpg`,
      kind: 'photograph', label: photo.angle, sha256: photo.sha256,
    }));
    continue;
  }
  const labels = record.listing.type === 'property'
    ? ['Living area', record.listing.bhk === 0 ? 'Sleeping area' : 'Bedroom', 'Kitchen']
    : ['Front view', 'Rear view'];
  for (const [index, label] of labels.entries()) {
    const title = record.listing.title || record.listing.name;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-label="${xml(`${title}: ${label} photograph unavailable`)}">
<rect width="1600" height="1000" fill="#eef2f5"/><rect x="80" y="80" width="1440" height="840" rx="28" fill="#fff" stroke="#cbd5df" stroke-width="3"/>
<g font-family="Arial,sans-serif" text-anchor="middle" fill="#17304a"><text x="800" y="245" font-size="35" fill="#13674d">DEMO / SAMPLE · ${record.key}</text>
<text x="800" y="360" font-size="42">${xml(title.replace(/^Sample /, ''))}</text><text x="800" y="445" font-size="30">${xml(record.listing.areaName)}, Mumbai</text>
<text x="800" y="570" font-size="46">${xml(label)} — photo unavailable</text><text x="800" y="660" font-size="29">Text-only placeholder. This is not a photograph.</text>
<text x="800" y="740" font-size="27">Fictional inventory — no verified rental offer.</text></g></svg>`;
    const filename = `${record.key}-${index + 1}.svg`;
    await writeFile(new URL(filename, publicDirectory), svg);
    record.previewGallery.push({ url: `/catalog-placeholders/${filename}`, kind: 'placeholder',
      label: `${label} photo unavailable — Demo/Sample`,
      attribution: 'RentSphere original text-only placeholder; not a photograph.',
      sha256: createHash('sha256').update(svg).digest('hex') });
  }
}
const selected = { schemaVersion: 1, batch: full.batch, scope: full.scope,
  selection: { profile: QUICK_PROFILE, keys: QUICK_KEYS, sourceManifestSha256: digest(full) },
  expected: { properties: 15, vehicles: 15 }, records };
validateCatalog(selected);
await writeFile(new URL('../catalog/mumbai-15x15.json', import.meta.url), JSON.stringify(selected, null, 2) + '\n');
await writeFile(new URL('../catalog/owner-approvals-15x15.example.json', import.meta.url), JSON.stringify({
  approved: false, manifestSha256: digest(selected), targetDatabase: null,
  presentationReviewed: false, temporaryPlaceholdersApproved: false, sampleDetailsApproved: false, publishSamples: false,
  assignments: Object.fromEntries(records.map(record => [record.key, { host: record.listing.host, approved: false }])),
}, null, 2) + '\n');
console.log('Prepared 15 properties + 15 vehicles from the existing staging manifest; placeholders remain explicitly non-photographic.');

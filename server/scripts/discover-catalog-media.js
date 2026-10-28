// Public-source discovery only. Candidates are never promoted to catalog photos.
// No environment loader, database connection, model import, or owner messaging.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const catalogPath = new URL('../catalog/mumbai-2026.json', import.meta.url);
const out = new URL('../catalog/media-candidates.json', import.meta.url);
const clean = value => String(value || '').replace(/<[^>]*>/g, '').replaceAll('&amp;', '&');

export async function findCandidates(model, fetcher = fetch) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [key, value] of Object.entries({ action: 'query', generator: 'search',
    gsrsearch: `"${model}"`, gsrnamespace: 6, gsrlimit: 8, prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|sha1', iiurlwidth: 1600, format: 'json' })) url.searchParams.set(key, value);
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'RentSphereCatalogPreparation/1.0 (public image provenance audit)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error(`Commons returned HTTP ${response.status}`), {
    status: response.status, retryAfter: response.headers.get('retry-after'),
  });
  const data = await response.json();
  if (data.error) throw new Error(`Commons API: ${data.error.code}`);
  return Object.values(data.query?.pages || {}).flatMap(page => {
    const info = page.imageinfo?.[0];
    if (!info) return [];
    const m = info.extmetadata || {};
    return [{ title: page.title, sourcePage: info.descriptionurl, originalUrl: info.url,
      reviewUrl: info.thumburl || info.url, width: info.width, height: info.height,
      commonsSha1: info.sha1, author: clean(m.Artist?.value),
      license: clean(m.LicenseShortName?.value), licenseUrl: clean(m.LicenseUrl?.value),
      attributionRequired: m.AttributionRequired?.value === 'true',
      description: clean(m.ImageDescription?.value), categories: clean(m.Categories?.value),
      approval: 'candidate-only',
      reviewNeeded: ['correct Indian model/generation/variant', 'distinct useful angle',
        'image quality', 'license and attribution', 'no duplicate across catalog'],
    }];
  });
}

async function main() {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const previous = process.argv.includes('--resume')
    ? JSON.parse(await readFile(out, 'utf8')).vehicles : [];
  const results = [];
  const records = catalog.records.filter(record => record.listing.type === 'vehicle');
  let throttled = false;
  for (const record of records) {
    const cached = previous.find(row => row.key === record.key && !row.error);
    if (cached) { results.push(cached); continue; }
    if (throttled) {
      results.push({ key: record.key, model: record.listing.name, candidates: [],
        error: 'Not attempted: source rate limit. Resume later; this is not evidence that images do not exist.' });
      continue;
    }
    try {
      results.push({ key: record.key, model: record.listing.name,
        candidates: await findCandidates(record.listing.name) });
    } catch (error) {
      results.push({ key: record.key, model: record.listing.name, candidates: [],
        error: error.message, retryAfter: error.retryAfter });
      if (error.status === 429) throttled = true;
    }
    console.log(`Image discovery ${results.length}/${records.length}`);
    if (!throttled) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  await writeFile(out, JSON.stringify({ checkedAt: new Date().toISOString(),
    note: 'Source metadata only. No candidate is approved or attached to a listing.',
    properties: { approvedSets: 0, blocker: 'No documented same-property multi-room Mumbai sets acquired; exterior/office/cafe search results rejected.' },
    vehicles: results }, null, 2) + '\n');
  console.log(`Saved candidate metadata to ${fileURLToPath(out)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

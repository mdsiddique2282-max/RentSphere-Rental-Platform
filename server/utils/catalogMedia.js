import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export async function loadImageDecoder(modulePath) {
  const resolved = modulePath ? createRequire(import.meta.url).resolve(modulePath) : null;
  const module = await import(resolved ? pathToFileURL(resolved).href : 'sharp');
  return module.default;
}

export async function inspectPhoto(url, { decoder, fetcher = fetch, now = new Date() } = {}) {
  if (typeof decoder !== 'function') throw new Error('A real image decoder is required.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Photos require public HTTPS URLs without credentials.');
  const response = await fetcher(url, { signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'RentSphereCatalogPreparation/1.0 (image verification)' } });
  if (!response.ok) throw new Error(`Image returned HTTP ${response.status}`);
  const maximum = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('Image exceeds 20 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) { await response.body.cancel?.().catch(() => {}); throw new Error('Image exceeds 20 MB.'); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const image = decoder(bytes, { limitInputPixels: 64000000 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('Expected one decoded photographic JPEG/PNG/WebP, not HTML/SVG/animation.');
  if (metadata.width < 1600 || metadata.height < 900) throw new Error(`Resolution too low: ${metadata.width} × ${metadata.height}`);
  const gray = await decoder(bytes).rotate().resize(9, 8, { fit: 'fill' }).greyscale().removeAlpha().raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | BigInt(gray[y * 9 + x] > gray[y * 9 + x + 1]);
  // Do not mark matching/licensing/visual quality approved: those need review.
  return { bytes, evidence: { httpStatus: response.status, checkedAt: now.toISOString(), decoded: true,
    width: metadata.width, height: metadata.height, format: metadata.format,
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    dHash: hash.toString(16).padStart(16, '0'), finalUrl: response.url || url } };
}

export async function verifyCatalogPhotos(catalog, options) {
  for (const record of catalog.records) for (const photo of record.media) {
    const { evidence } = await inspectPhoto(photo.url, options);
    if (evidence.sha256 !== photo.sha256 || evidence.width !== photo.width ||
        evidence.height !== photo.height || evidence.dHash !== photo.dHash) {
      throw new Error(`Image content changed since approval: ${record.key}`);
    }
  }
}

export async function verifyPreviewAssets(catalog) {
  const seen = new Set();
  for (const record of catalog.records) for (const asset of record.previewGallery || []) {
    if (seen.has(asset.sha256)) throw new Error('Preview gallery assets must be distinct across listings.');
    seen.add(asset.sha256);
    const path = asset.kind === 'placeholder'
      ? new URL(`../../public${asset.url}`, import.meta.url)
      : new URL(`../../public${asset.url}`, import.meta.url);
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Preview asset changed: ${record.key}`);
    if (asset.kind === 'placeholder') {
      const text = bytes.toString('utf8');
      if (!text.includes('This is not a photograph.') || !text.includes(record.key) || /<(image|script|foreignObject)\b/i.test(text)) throw new Error(`Placeholder must be text-only and explicitly labelled: ${record.key}`);
    }
  }
}


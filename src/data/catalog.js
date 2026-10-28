export const isSample = item => item?.inventoryKind === 'sample';
// Keep the existing UI helpers; staging uses the same authoritative database
// presentation without claiming that its remote database is an isolated preview.
export const isIsolatedPreview = item => item?.previewContext === 'catalog-isolated' || item?.catalogContext === 'staging';
export const previewAvailability = item => item?.status === 'available' && item.available !== false && !/unavailable|not available|rented|booked/i.test(item.availability || '') ? 'Available' : 'Unavailable';
export const previewTitle = item => isIsolatedPreview(item) && isSample(item)
  ? String(item.title || item.name).replace(/^Sample /, '').replace(/^./, value => value.toUpperCase())
  : item.title || item.name;
export const previewDescription = item => isIsolatedPreview(item) && isSample(item)
  ? String(item.description || '').split(/ (?:This example|Use this example)\b/)[0]
    .replace(/^Sample /, '').replace(/^./, value => value.toUpperCase())
  : item.description;
const originalSignature = item => `${item.title || item.name}|${item.location}|${item.price}`.toLowerCase();
export const isStagingDevelopment = () => typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="rentsphere-staging"]'));
// Presentation correction is limited to these five isolated preview vehicles.
const correctedPreviewKeys = new Set(['M01', 'M03', 'M10', 'M15', 'M17'].map(key => `mumbai-2026-${key}`));
export const isCorrectedPreviewVehicle = item => item?.type === 'vehicle' &&
  item.previewOnly === true && isSample(item) && correctedPreviewKeys.has(item.catalogKey);
export function previewVehicleAvailability(item) {
  const states = [item.status, item.availability, item.badge].map(value => String(value || '').toLowerCase());
  return item.available === false || states.some(value => ['unavailable', 'rented', 'booked'].includes(value))
    ? 'Unavailable' : 'Available';
}
export const includedFeatures = item => (isIsolatedPreview(item) && item.type === 'vehicle') || isCorrectedPreviewVehicle(item)
  ? (item.features || [])
  : (item.type === 'vehicle' ? item.features || [] : item.amenities || []);
export const sampleNotice = item => isSample(item)
  ? 'DEMO / SAMPLE REQUEST — fictional inventory; no real rental or reservation.\n' : '';
export function mergeCatalog(api, legacy) {
  if (isStagingDevelopment() || api.some(item => item.catalogContext === 'staging')) {
    const seen = new Set();
    return api.filter(item => { const id = String(item._id || item.id); if (seen.has(id)) return false; seen.add(id); return true; });
  }
  if (api.some(isIsolatedPreview)) {
    const seen = new Set();
    const rows = api.filter(item => { const id = String(item._id || item.id); if (seen.has(id)) return false; seen.add(id); return true; });
    return [...rows, ...legacy.filter(item => !rows.some(row => row.legacyId === item.id ||
      !isSample(row) && originalSignature(row) === originalSignature(item)))];
  }
  // Keep today's fallback behavior until DB sample inventory is actually present.
  // Once present, avoid appending a second frontend-only demo catalog.
  return api.some(item => isSample(item)) ? api : [...api, ...legacy];
}
export function previewSimilar(item, candidates, count = 3) {
  const identities = row => [row.id, row._id, row.legacyId].filter(Boolean).map(String);
  const current = new Set(identities(item));
  const category = row => row.category || (['vehicle', 'property'].includes(row.type) ? row.kind : row.type);
  const words = row => String(row.location || '').toLowerCase().split(/[, ]+/).filter(word => word && !['maharashtra', 'tamil', 'nadu', 'india', 'pradesh'].includes(word));
  const score = row => (words(item).some(word => words(row).includes(word)) ? 4 : 0) +
    3 / (1 + Math.abs((row.price || 0) - (item.price || 0)) / Math.max(item.price || 1, 1)) +
    (category(row) === category(item) ? 6 : 0) +
    (item.type === 'property' ? (row.bhk === item.bhk ? 5 : 0) : row.kind === item.kind ? 2 : 0);
  return candidates.filter(row => !identities(row).some(id => current.has(id)))
    .sort((a, b) => score(b) - score(a) || String(a._id || a.id).localeCompare(String(b._id || b.id))).slice(0, count);
}
export function recommendedOrder(a, b) {
  return Number(isSample(a)) - Number(isSample(b)) ||
    (Date.parse(b.publishedAt || b.createdAt) || 0) - (Date.parse(a.publishedAt || a.createdAt) || 0) ||
    String(a.id || a._id).localeCompare(String(b.id || b._id));
}
// Property-only diversification: keep the existing relevance order, with both
// original and sample inventory represented where both are present.
export function previewPropertySimilar(item, candidates, count = 3) {
  const seen = new Set();
  const unique = candidates.filter(row => {
    const id = String(row._id || row.id);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  const ranked = previewSimilar(item, unique, unique.length);
  const result = ranked.slice(0, count);
  if (count > 1) for (const sample of [false, true]) {
    if (!result.some(row => isSample(row) === sample)) {
      const match = ranked.find(row => isSample(row) === sample);
      if (match) result.splice(Math.max(0, result.length - 1), 1, match);
    }
  }
  return result;
}
const xml = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
export function unavailablePhoto(item) {
  const title = xml(item?.title || item?.name || 'RentSphere listing');
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#eef2f5"/><g text-anchor="middle" font-family="Arial" fill="#17304a"><text x="800" y="400" font-size="38">${title}</text><text x="800" y="520" font-size="44">Photo unavailable</text><text x="800" y="620" font-size="28">${isSample(item) ? 'Demo / Sample — not a real rental offer' : 'No replacement photograph supplied'}</text></g></svg>`)}`;
}

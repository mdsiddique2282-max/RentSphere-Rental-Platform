const configuredContact = '919403570134';
// Original predefined DB inventory (server/catalog/original-listings.json).
// These rows have hosts but predate legacyId/catalogKey/sample metadata.
const predefinedDatabaseIds = new Set([
  '6ad4ac1d98166bf0d4230f0f', '6ad4ac1d98166bf0d4230f10',
  '6ad4ac1d98166bf0d4230f11', '6ad4ac1d98166bf0d4230f12',
  '6ad4ac1d98166bf0d4230f13', '6ad4ac1d98166bf0d4230f14',
  '6ad4ac1d98166bf0d4230f15', '6ad4ac1d98166bf0d4230f16',
]);

const knownPredefined = item => predefinedDatabaseIds.has(String(item?._id || item?.id)) || Boolean(item?.legacyId || item?.catalogKey);
// Current owner-form records have this server-managed marker. Catalog identities
// take precedence, including catalog listings later edited through that form.
export const isGenuineOwnerUpload = item => !knownPredefined(item) && item?.hostingDetailsVersion === 1;
export const isSampleRequest = item => item?.inventoryKind === 'sample' && !isGenuineOwnerUpload(item);

export function whatsappRecipient(item) {
  if (!item) throw new Error('Owner contact is unavailable for this listing.');
  const predefined = knownPredefined(item) || isSampleRequest(item) || (!item._id && !item.host && !isGenuineOwnerUpload(item));
  if (predefined) return configuredContact;
  const digits = String(item.phone || '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return '91' + digits;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  throw new Error('This listing needs a valid owner contact number before sharing a WhatsApp request.');
}

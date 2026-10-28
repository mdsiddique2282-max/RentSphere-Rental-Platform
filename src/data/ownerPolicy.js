// Shared validation and legacy category interpretation; never rewrites approved data.
export const proofTypes = ['Aadhaar Card', 'PAN Card', 'Passport', 'Driving License'];
export const validOwnerPhone = value => typeof value === 'string' && /^(?:\+91)?[6-9]\d{9}$/.test(value.replace(/[\s-]/g, ''));
export function ownerListingTypes(profile) {
  const value = String(profile?.listingIntent || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (['property', 'properties', 'room', 'rooms', 'properties / rooms', 'property/rooms'].includes(value)) return ['property'];
  if (['vehicle', 'vehicles'].includes(value)) return ['vehicle'];
  return value === 'both' ? ['property', 'vehicle'] : [];
}
export function ownerProfileErrors(values = {}) {
  const errors = {};
  for (const [key, message] of Object.entries({ phone: 'Please enter your contact phone number.', address: 'Please enter your complete address.', city: 'Please enter your city.', state: 'Please enter your state.', bio: 'Please enter a short bio.' })) {
    if (typeof values[key] !== 'string' || !values[key].trim()) errors[key] = message;
    else if (values[key].length > (key === 'bio' ? 2000 : 500)) errors[key] = 'Please enter a shorter value.';
  }
  if (!errors.phone && !validOwnerPhone(values.phone)) errors.phone = 'Please enter a valid 10-digit Indian mobile number.';
  if (!['property', 'vehicle', 'both'].includes(values.listingIntent)) errors.listingIntent = 'Please select what you plan to list.';
  return errors;
}
export function ownerDocumentErrors(values = {}, documents = []) {
  const errors = {};
  if (!proofTypes.includes(values.idProofType)) errors.idProofType = 'Please select a valid ID proof type.';
  if (typeof values.idProofNumber !== 'string' || !values.idProofNumber.trim()) errors.idProofNumber = 'Please enter your ID proof number.';
  else if (values.idProofNumber.length > 200) errors.idProofNumber = 'Please enter a shorter ID proof number.';
  if (!documents.length) errors.documents = 'Please upload at least one verification document.';
  return errors;
}
export function ownerFileError(files) {
  if (files.length > 5) return 'Choose at most 5 documents per upload.';
  if (files.some(file => !(file.type || file.mimetype || '').startsWith('image/') && (file.type || file.mimetype) !== 'application/pdf')) return 'Only image or PDF files are allowed.';
  if (files.some(file => !file.size || file.size > 5 * 1024 * 1024)) return 'Each document must be non-empty and 5 MB or smaller.';
  return '';
}

// Detail-page presentation only; preserve the existing category/kind mapping.
export function isListingUnavailable(item) {
  const states = [item.status, item.availability, item.badge].map(value => String(value || '').trim().toLowerCase());
  const unavailable = item.available === false || Boolean(item.archivedAt) || item.publicationState === 'draft' || states.some(value => /\b(unavailable|rented|booked)\b|not available/.test(value));
  const available = item.available === true || states.some(value => /^available\b/.test(value));
  return unavailable || !available;
}
export function detailHeader(item, isProperty, propertyRented = false) {
  const type = isProperty ? item.category || item.type || 'Property' : item.kind || item.category || item.type || 'Vehicle';
  if (!isProperty) return `${type} · ${vehicleBookingDisplay(item).label}`;
  return `${type} · ${!propertyRented && !isListingUnavailable(item) ? 'Available' : 'Unavailable'}`;
}

export function vehicleBookingDisplay(item) {
  if (isListingUnavailable(item)) return { state: 'unavailable', label: 'CURRENTLY UNAVAILABLE' };
  if (item.vehicleBookingStatus === 'partially-booked') return { state: 'partial', label: 'PARTIALLY BOOKED' };
  if (item.vehicleBookingStatus === 'available') return { state: 'available', label: 'AVAILABLE' };
  if (item.vehicleBookingStatus === 'unavailable') return { state: 'unavailable', label: 'CURRENTLY UNAVAILABLE' };
  return { state: 'loading', label: 'Checking availability…' };
}

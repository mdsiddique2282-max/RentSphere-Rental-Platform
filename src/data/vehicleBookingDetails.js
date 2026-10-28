import { isCoordinates } from './coordinates.js';

export function pickupLocationUrl(coordinates) {
  return isCoordinates(coordinates) ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coordinates.lat},${coordinates.lon}`)}` : null;
}

// Read saved values only. Legacy cards may show the current listing address, but
// never invent historical coordinates or a driving distance for an estimate.
export function vehicleBookingDetails(booking) {
  const delivery = booking.fulfilment === 'delivery';
  const quote = delivery ? booking.deliveryQuote : undefined;
  const pickupCoordinates = delivery ? quote?.pickupCoordinates || booking.vehicleSnapshot?.pickupCoordinates : booking.vehicleSnapshot?.pickupCoordinates;
  const destination = quote?.deliveryCoordinates || booking.deliveryCoordinates;
  const total = Number.isFinite(booking.totalPrice) ? booking.totalPrice : undefined;
  const charge = delivery ? Number.isFinite(booking.deliveryCharge) ? booking.deliveryCharge : undefined : 0;
  const rental = delivery && Number.isFinite(quote?.rentalAmount) ? quote.rentalAmount : total !== undefined && charge !== undefined && total >= charge ? total - charge : undefined;
  const distance = delivery && quote?.kind === 'calculated' && Number.isFinite(quote.distanceMeters) && quote.distanceMeters >= 0 ? quote.distanceMeters : undefined;
  const duration = Math.max(1, Math.round((new Date(booking.endDate) - new Date(booking.startDate)) / 86400000));
  return {
    delivery, name: booking.vehicleSnapshot?.name || booking.listing?.title || booking.listing?.name,
    pickupAddress: quote?.pickupAddress || booking.vehicleSnapshot?.pickupAddress || booking.listing?.location,
    deliveryAddress: booking.deliveryAddress || quote?.deliveryAddress,
    pickupCoordinates, distance, estimated: delivery && quote?.kind === 'estimated', rental, charge, total,
    dailyRate: rental !== undefined && Number.isFinite(duration) ? rental / duration : undefined,
    locationUrl: !delivery ? pickupLocationUrl(pickupCoordinates) : null,
    routeUrl: delivery && isCoordinates(pickupCoordinates) && isCoordinates(destination)
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${pickupCoordinates.lat},${pickupCoordinates.lon}`)}&destination=${encodeURIComponent(`${destination.lat},${destination.lon}`)}&travelmode=driving` : null,
  };
}

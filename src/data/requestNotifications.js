import { whatsappRecipient } from './whatsappRecipient.js';

export function requestNotification(row) {
  const property = row.requestType === 'property_visit' || row.listing?.type === 'property';
  const accepted = row.status === 'confirmed';
  if (row.status === 'cancelled') return { title: 'Your Vehicle Booking Has Been Cancelled', description: 'The owner cancelled this booking and released its reserved dates. Your booking details remain in your history.', accepted: false };
  const name = row.listing?.title || row.listing?.name || (property ? 'this property' : 'this vehicle');
  const title = property
    ? accepted ? 'Your Property Visit Has Been Approved!' : 'Your Property Visit Request Has Been Rejected'
    : accepted ? 'Your Booking Request Has Been Accepted!' : 'Your Booking Request Has Been Rejected';
  const description = property
    ? accepted ? `Your visit request for ${name} has been approved. Please contact the owner to confirm the exact property location and visiting time.` : `Your visit request for ${name} was rejected by the owner. You can explore other available properties.`
    : accepted ? `Your booking request for ${name} has been accepted by the owner. Please contact the owner to confirm pickup or delivery details.` : `Your booking request for ${name} was rejected by the owner. You can explore other available vehicles.`;
  let contactUrl, contactError;
  if (accepted) {
    try {
      const recipient = whatsappRecipient(row.listing);
      const message = property
        ? `Hello, my RentSphere visit request for ${name} on ${row.startDate?.slice(0, 10) || 'the selected date'} has been approved. Could you share the exact location and a suitable visiting time? Thank you!`
        : `Hello, my RentSphere booking request for ${name} (${row.startDate?.slice(0, 10) || 'selected dates'} to ${row.endDate?.slice(0, 10) || 'selected dates'}) has been accepted. Could we confirm pickup or delivery details? Thank you!`;
      contactUrl = `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`;
    } catch { contactError = 'The listing owner contact is unavailable. Please check the listing or try again later.'; }
  }
  return { title, description, accepted, contactUrl, contactError };
}

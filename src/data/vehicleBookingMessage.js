import { formatPrice } from './listings.js';
import { vehicleBookingDetails } from './vehicleBookingDetails.js';

export function vehicleBookingMessage({ booking }) {
  const details = vehicleBookingDetails(booking);
  const contact = booking.contact, start = booking.startDate?.slice(0, 10), end = booking.endDate?.slice(0, 10);
  // New messages require the saved response, never editable form totals or listing prices.
  if (!booking._id || !['pickup', 'delivery'].includes(booking.fulfilment) || !booking.vehicleSnapshot?.name || !booking.vehicleSnapshot.pickupAddress || !contact?.name || !contact?.phone ||
      !/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') ||
      !Number.isFinite(details.total) || details.total < 0 || !Number.isFinite(details.charge) || details.charge < 0 ||
      (!details.delivery && booking.deliveryCharge !== 0) ||
      (details.delivery && (!details.deliveryAddress || !Number.isFinite(booking.deliveryQuote?.rentalAmount) || booking.deliveryQuote.rentalAmount < 0 ||
        booking.deliveryQuote.deliveryCharge !== details.charge || booking.deliveryQuote.totalPrice !== details.total ||
        (!details.estimated && details.distance === undefined)))) throw new Error('Saved booking details are incomplete. Open your Dashboard to review this request.');
  const rental = details.delivery ? booking.deliveryQuote.rentalAmount : details.total;
  const addresses = `*Pickup Address:* ${details.pickupAddress}${details.delivery ? `\n*Delivery Address:* ${details.deliveryAddress}\n${details.estimated ? '*Road Distance:* Not calculated (estimated delivery charge; subject to owner confirmation)' : `*Road Distance:* ${(details.distance / 1000).toFixed(2)} km`}` : ''}`;
  return `🚗 *RentSphere – Vehicle Booking Request*\n\n*Vehicle:* ${booking.vehicleSnapshot.name}\n*Dates:* ${start} – ${end}\n*Method:* ${details.delivery ? 'Home Delivery' : 'Self Pickup'}\n\n*Customer Details:*\nName: ${contact.name}\nPhone: ${contact.phone}\n\n${addresses}\n\n*Rental Amount:* ₹${formatPrice(rental)}\n*Delivery Charge:* ₹${formatPrice(details.charge)}\n*Total Amount:* ₹${formatPrice(details.total)}\n\n*Customer Message:*\n${details.delivery ? "I'd like to book this vehicle with home delivery. Please confirm availability and expected delivery time." : "I'd like to book this vehicle. Please confirm availability, pickup time and required documents."}\n\n*Note for Owner:*\nLog in to your RentSphere Owner Dashboard to Accept or Reject this request.`;
}

import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Listing from '../models/Listing.js';

const DAY_MS = 86400000;
export const VEHICLE_DELIVERY_CHARGE = 300;
const failure = (status, message) => Object.assign(new Error(message), { status });

// The existing UI uses calendar dates, not pickup/return times. Both selected
// dates are occupied; a same-day rental costs a minimum of one day.
export function bookingDates(startDate, endDate) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  };
  const start = parse(startDate);
  const end = parse(endDate);
  if (!start || !end) throw failure(400, 'Valid start and end dates (YYYY-MM-DD) are required.');
  if (end < start) throw failure(400, 'End date cannot be before the start date.');
  return { start, end, days: Math.max(1, Math.round((end - start) / DAY_MS)) };
}

export function bookingPrice(listing, dates, fulfilment) {
  if (!Number.isFinite(listing.price) || listing.price < 0) {
    throw failure(400, 'This listing does not have a valid rental price.');
  }
  if (fulfilment !== 'pickup' && fulfilment !== 'delivery') {
    throw failure(400, "Fulfilment must be either 'pickup' or 'delivery'.");
  }
  const deliveryCharge = fulfilment === 'delivery' ? VEHICLE_DELIVERY_CHARGE : 0;
  const rentalDays = listing.type === 'vehicle' ? dates.days : 1;
  const totalPrice = Math.round((listing.price * rentalDays + deliveryCharge) * 100) / 100;
  if (!Number.isFinite(totalPrice) || totalPrice > Number.MAX_SAFE_INTEGER / 100) {
    throw failure(400, 'The requested rental total is too large.');
  }
  return { totalPrice, deliveryCharge };
}

// Reusable by the upcoming availability API. Only confirmed bookings block dates.
export function confirmedOverlapFilter(listingId, start, end, excludeId) {
  const endOfDay = new Date(end);
  endOfDay.setUTCHours(23, 59, 59, 999);
  const startOfDay = new Date(start);
  startOfDay.setUTCHours(0, 0, 0, 0);
  return {
    listing: listingId,
    status: 'confirmed',
    startDate: { $lte: endOfDay },
    endDate: { $gte: startOfDay },
    ...(excludeId ? { _id: { $ne: excludeId } } : {})
  };
}

export async function assertVehicleAvailable(listingId, start, end, { session = null, excludeId } = {}) {
  const conflict = await Booking.exists(confirmedOverlapFilter(listingId, start, end, excludeId)).session(session);
  if (conflict) throw failure(409, 'This vehicle already has a confirmed booking on the selected dates.');
}

// All confirmations must use this transaction. Writing the shared listing first
// serializes concurrent confirmations even when they concern different bookings.
// MongoDB must support transactions (a replica set or sharded cluster).
export async function confirmVehicleBooking(bookingId, actor) {
  return mongoose.connection.transaction(async session => {
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking) throw failure(404, 'Booking not found.');
    const listing = await Listing.findOneAndUpdate(
      { _id: booking.listing, type: 'vehicle' },
      { $inc: { bookingRevision: 1 } },
      { new: true, session }
    );
    if (!listing) throw failure(404, 'Vehicle not found.');
    if (actor.role !== 'admin' && String(listing.host) !== String(actor._id)) {
      throw failure(403, 'Only the vehicle owner or an admin can confirm this booking.');
    }
    if (!['pending', 'confirmed'].includes(booking.status)) {
      throw failure(409, 'Only pending bookings can be confirmed.');
    }
    await assertVehicleAvailable(listing._id, booking.startDate, booking.endDate, { session, excludeId: booking._id });
    if (booking.status === 'confirmed') return booking;
    const dates = bookingDates(booking.startDate.toISOString().slice(0, 10), booking.endDate.toISOString().slice(0, 10));
    Object.assign(booking, bookingPrice(listing, dates, booking.fulfilment));
    booking.status = 'confirmed';
    await booking.save({ session });
    return booking;
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
}

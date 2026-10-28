import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Listing from '../models/Listing.js';
import { assertRequestTransition } from './workflowPolicy.js';
import { todayInIndia } from './requestDates.js';

const DAY_MS = 86400000;
export const VEHICLE_DELIVERY_CHARGE = 300;
const failure = (status, message) => Object.assign(new Error(message), { status });

// Read-only response projection. One lookup covers a complete listing page;
// neither booking statuses nor the owner's availability fields are rewritten.
export async function withVehicleBookingStatus(value, now = new Date()) {
  const rows = (Array.isArray(value) ? value : [value]).map(row => typeof row?.toObject === 'function' ? row.toObject() : row);
  const ids = rows.filter(row => row?.type === 'vehicle').map(row => row._id);
  const booked = new Set(ids.length ? (await Booking.distinct('listing', { listing: { $in: ids }, status: 'confirmed',
    endDate: { $gte: new Date(todayInIndia(now) + 'T00:00:00.000Z') } })).map(String) : []);
  const result = rows.map(row => {
    if (row?.type !== 'vehicle') return row;
    const unavailable = row.available === false || row.status !== 'available' || row.archivedAt || row.publicationState === 'draft' ||
      /unavailable|not available|rented|booked/i.test(row.availability || '') || /^(unavailable|rented|booked)$/i.test(row.badge || '');
    return { ...row, vehicleBookingStatus: unavailable ? 'unavailable' : booked.has(String(row._id)) ? 'partially-booked' : 'available' };
  });
  return Array.isArray(value) ? result : result[0];
}

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
export async function confirmVehicleBooking(bookingId, actor, { requirePending = false } = {}) {
  return mongoose.connection.transaction(async session => {
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking) throw failure(404, 'Booking not found.');
    const listing = await Listing.findOne({ _id: booking.listing, type: 'vehicle' }).session(session);
    if (!listing) throw failure(404, 'Vehicle not found.');
    assertRequestTransition({ kind: 'vehicle', from: booking.status, to: 'confirmed',
      actor, customerId: booking.user, hostId: listing.host });
    if (requirePending && booking.status !== 'pending') throw failure(409, 'This request has already been processed. Refresh to see its latest status.');
    if (booking.status === 'confirmed') return booking;
    if (listing.archivedAt || listing.publicationState === 'draft' || listing.available === false || listing.status !== 'available' ||
        /unavailable|not available|rented|booked/i.test(listing.availability || '') || /^(unavailable|rented|booked)$/i.test(listing.badge || '')) {
      throw failure(409, 'This vehicle is unavailable.');
    }
    // Authorize before taking the shared listing write lock. This lock retains
    // the existing protection against concurrent overlapping confirmations.
    const locked = await Listing.updateOne(
      { _id: listing._id, host: listing.host, type: 'vehicle' },
      { $inc: { bookingRevision: 1 } }, { session }
    );
    if (!locked.matchedCount) throw failure(409, 'Vehicle changed. Please retry.');
    await assertVehicleAvailable(listing._id, booking.startDate, booking.endDate, { session, excludeId: booking._id });
    if (booking.status === 'confirmed') return booking;
    const dates = bookingDates(booking.startDate.toISOString().slice(0, 10), booking.endDate.toISOString().slice(0, 10));
    // Reviewed delivery amounts and historical stored charges are never repriced at acceptance.
    if (booking.fulfilment !== 'delivery') Object.assign(booking, bookingPrice(listing, dates, booking.fulfilment));
    booking.status = 'confirmed';
    booking.ownerDecision = { status: 'confirmed', decidedAt: new Date() };
    await booking.save({ session });
    return booking;
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
}

export async function rejectVehicleBooking(id, actor) {
  return mongoose.connection.transaction(async session => {
    const booking = await Booking.findById(id).session(session);
    if (!booking) throw failure(404, 'Booking not found.');
    const listing = await Listing.findOne({ _id: booking.listing, type: 'vehicle' }).session(session);
    if (!listing) throw failure(400, 'This is not a vehicle booking.');
    assertRequestTransition({ kind: 'vehicle', from: booking.status, to: 'rejected', actor, customerId: booking.user, hostId: listing.host });
    await Listing.updateOne({ _id: listing._id }, { $inc: { bookingRevision: 1 } }, { session });
    const updated = await Booking.findOneAndUpdate({ _id: booking._id, status: 'pending' }, { $set: { status: 'rejected', ownerDecision: { status: 'rejected', decidedAt: new Date() } } }, { session, returnDocument: 'after', runValidators: true });
    if (!updated) throw failure(409, 'Request changed. Please refresh.');
    return updated;
  });
}

// The shared listing lock serializes release with confirmations and availability changes.
export async function releaseVehicleBooking(id, actor, selectedDate) {
  bookingDates(selectedDate, selectedDate);
  if (selectedDate < todayInIndia()) throw failure(400, 'Past dates cannot be made available.');
  return mongoose.connection.transaction(async session => {
    const booking = await Booking.findById(id).session(session);
    if (!booking) throw failure(404, 'Booking not found.');
    const listing = await Listing.findOne({ _id: booking.listing, type: 'vehicle' }).session(session);
    if (!listing || actor.role !== 'owner' || actor.ownerProfile?.status !== 'approved' || String(listing.host) !== String(actor._id)) throw failure(403, 'Only the verified vehicle owner may release this booking.');
    if (selectedDate < booking.startDate.toISOString().slice(0, 10) || selectedDate > booking.endDate.toISOString().slice(0, 10) || ['property_visit', 'property_booking'].includes(booking.requestType)) throw failure(400, 'The selected date does not belong to this vehicle booking.');
    if (booking.status === 'cancelled') return booking;
    if (booking.status !== 'confirmed') throw failure(409, 'Only confirmed bookings can be made available. Refresh the calendar.');
    const locked = await Listing.updateOne({ _id: listing._id, host: actor._id }, { $inc: { bookingRevision: 1 } }, { session });
    if (!locked.matchedCount) throw failure(409, 'Vehicle changed. Please retry.');
    booking.status = 'cancelled';
    booking.ownerDecision = { status: 'cancelled', decidedAt: new Date() };
    await booking.save({ session });
    return booking;
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
}

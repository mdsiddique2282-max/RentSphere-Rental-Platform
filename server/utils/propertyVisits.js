import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Listing from '../models/Listing.js';
import { assertRequestTransition } from './workflowPolicy.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
export function assertPropertyAvailable(listing) {
  if (listing.available === false || listing.archivedAt || listing.publicationState === 'draft' ||
      (listing.status && listing.status !== 'available') ||
      /unavailable|not available|rented/i.test(listing.availability || '')) {
    throw failure(409, 'This property is unavailable for new requests.');
  }
}

export async function decidePropertyVisit(id, actor, status, { requirePending = false } = {}) {
  return mongoose.connection.transaction(async session => {
    const booking = await Booking.findById(id).session(session);
    if (!booking) throw failure(404, 'Booking not found.');
    if (booking.requestType !== 'property_visit') throw failure(400, 'This request is not a property visit.');
    const listing = await Listing.findById(booking.listing).session(session);
    if (!listing || listing.type !== 'property') throw failure(404, 'Property not found.');
    assertRequestTransition({ kind: 'property_visit', from: booking.status, to: status,
      actor, customerId: booking.user, hostId: listing.host });
    if (requirePending && booking.status !== 'pending') throw failure(409, 'This request has already been processed. Refresh to see its latest status.');
    if (booking.status === status) return booking;
    if (status === 'confirmed') assertPropertyAvailable(listing);
    const locked = await Listing.updateOne({ _id: listing._id, host: listing.host },
      { $inc: { bookingRevision: 1 } }, { session });
    if (!locked.matchedCount) throw failure(409, 'Property changed. Please retry.');
    const updated = await Booking.findOneAndUpdate({ _id: id, status: booking.status },
      { $set: { status, ownerDecision: { status, decidedAt: new Date() } } }, { session, returnDocument: 'after', runValidators: true });
    if (!updated) throw failure(409, 'Request changed. Please reload.');
    return updated;
  });
}

// Run inside the same transaction as a visit decision/cancellation. Every call
// writes the listing, serializing competing decisions and owner availability.
export async function syncPropertyInterestAvailability(db, listing, session, newInterest = false) {
  const interested = await db.collection('bookings').findOne({ listing: listing._id,
    requestType: 'property_visit', status: 'confirmed', 'propertyDecision.kind': 'interested' }, { session });
  const restricted = listing.available === false || listing.status === 'rented' || listing.archivedAt ||
    listing.publicationState === 'draft' || /unavailable|not available|rented|booked/i.test(listing.availability || '');
  let fields = {};
  // A manual Make Available clears interestUnavailable. Historical decisions,
  // retries and cancellations must not recreate that explicitly cleared hold.
  if (interested && (newInterest || listing.interestUnavailable) && (!restricted || listing.interestUnavailable)) {
    fields = { available: false, availability: 'Unavailable', interestUnavailable: true };
  } else if (!interested && listing.interestUnavailable && listing.status !== 'rented' && !listing.archivedAt && listing.publicationState !== 'draft') {
    fields = { available: true, availability: 'Available now', interestUnavailable: false };
  }
  await db.collection('listings').updateOne({ _id: listing._id },
    { $set: { ...fields, updatedAt: new Date() }, $inc: { bookingRevision: 1 } }, { session });
  return { ...listing, ...fields };
}

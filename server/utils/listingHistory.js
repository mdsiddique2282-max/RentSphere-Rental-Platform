import mongoose from 'mongoose';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import { deleteListingFiles } from './uploadImages.js';

// The same listing write lock is used by request creation and decisions.
export async function removeListing(listing) {
  let deleted;
  const result = await mongoose.connection.transaction(async session => {
    deleted = null;
    const locked = await Listing.findOneAndUpdate({ _id: listing._id, host: listing.host,
      updatedAt: listing.updatedAt, archivedAt: { $exists: false } },
    { $inc: { bookingRevision: 1 } }, { session, returnDocument: 'after' });
    if (!locked) throw Object.assign(new Error('Listing changed. Please reload before retrying.'), { status: 409 });
    if (await Booking.exists({ listing: listing._id }).session(session) || await User.exists({ savedListings: listing._id }).session(session)) {
      await Listing.updateOne({ _id: listing._id }, { $set: { archivedAt: new Date() } }, { session });
      return 'archived';
    }
    deleted = await Listing.findOneAndDelete({ _id: listing._id }, { session });
    return 'deleted';
  });
  if (deleted) await deleteListingFiles(deleted);
  return result;
}

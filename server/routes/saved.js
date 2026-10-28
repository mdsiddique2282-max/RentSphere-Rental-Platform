import express from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import { authenticatedUser } from '../utils/authenticatedUser.js';
import { publicCatalogFilter } from '../utils/stagingPublicCatalog.js';
import { withVehicleBookingStatus } from '../utils/vehicleBookings.js';

const router = express.Router();
router.use(authenticatedUser);
router.get('/', async (req, res) => {
  try {
    const account = await User.findById(req.user._id).select('+savedListings');
    const filter = publicCatalogFilter(mongoose.connection.name);
    const rows = await Listing.find({ $and: [{ _id: { $in: account.savedListings || [] } }, filter], archivedAt: { $exists: false }, publicationState: { $ne: 'draft' } }).lean();
    res.json(await withVehicleBookingStatus(rows.map(row => ({ ...row, catalogContext: 'staging' }))));
  } catch { res.status(503).json({ message: 'Unable to load saved listings.' }); }
});
async function savedId(value) {
  if (/^[a-f\d]{24}$/i.test(value)) return value;
  if (/^(RS|V)\d+$/.test(value)) return (await Listing.findOne({ legacyId: value }).select('_id'))?._id;
}
for (const method of ['put', 'delete']) router[method]('/:id', async (req, res) => {
  try {
    const id = await savedId(req.params.id);
    if (!id) return res.status(404).json({ message: 'Listing not found.' });
    if (method === 'put') await mongoose.connection.transaction(async session => {
      // Serialize with listing/account deletion: a successful save must never
      // retain a reference to a concurrently deleted listing.
      const listing = await Listing.findOneAndUpdate({ $and: [{ _id: id }, publicCatalogFilter(mongoose.connection.name)], archivedAt: { $exists: false }, publicationState: { $ne: 'draft' } },
        { $inc: { bookingRevision: 1 } }, { session, returnDocument: 'after' });
      if (!listing) throw Object.assign(new Error('Listing not found.'), { status: 404 });
      const result = await User.updateOne({ _id: req.user._id }, { $addToSet: { savedListings: id } }, { session });
      if (!result.matchedCount) throw Object.assign(new Error('Please log in.'), { status: 401 });
    });
    else await User.updateOne({ _id: req.user._id }, { $pull: { savedListings: id } });
    res.json({ saved: method === 'put', listingId: String(id) });
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to update saved listings.' }); }
});
export default router;

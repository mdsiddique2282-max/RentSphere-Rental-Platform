import express from 'express';
import { removeListing } from '../utils/listingHistory.js';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import { verifyToken, sessionIsCurrent } from '../utils/tokens.js';
import mongoose from 'mongoose';
import { deleteListingFiles } from './listings.js';
import { upsertOwnerApp } from '../utils/ownerStore.js';
import { confirmVehicleBooking, rejectVehicleBooking } from '../utils/vehicleBookings.js';
import { decidePropertyVisit } from '../utils/propertyVisits.js';

const router = express.Router();

// Strict authentication + authorization: a valid JWT for an existing user whose role in the
// database is 'admin'. No dummy-token path, no fallback/borrowed identity, no role guessing.
const adminProtect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, please log in.' });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (jwtErr) {
    return res.status(401).json({ message: 'Not authorized, invalid or expired token.' });
  }

  if (!decoded || !decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
    return res.status(401).json({ message: 'Not authorized, invalid token.' });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }

  try {
    const user = await User.findById(decoded.id).select('-password').maxTimeMS(5000);
    if (!user || !sessionIsCurrent(decoded, user)) {
      return res.status(401).json({ message: 'Not authorized, user no longer exists.' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error('Auth lookup failed in adminProtect:', err.message);
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }
};

const activeListings = { archivedAt: { $exists: false } };

// Both management sections use the original bookings collection, including
// archived listings, hidden history and predefined inventory without an owner.
router.get('/requests', adminProtect, async (req, res) => {
  const kind = req.query.type;
  if (!['vehicle', 'property_visit'].includes(kind)) return res.status(400).json({ message: 'Choose vehicle bookings or property visits.' });
  if (req.query.archived !== undefined && !['true', 'false'].includes(req.query.archived)) return res.status(400).json({ message: 'Choose active or archived requests.' });
  try {
    const filter = kind === 'vehicle' ? { $or: [{ requestType: 'vehicle' }, { requestType: { $exists: false } }] } : { requestType: 'property_visit' };
    const rows = await Booking.find({ ...filter, adminHidden: { $ne: true }, hiddenFromAdmin: req.query.archived === 'true' ? true : { $ne: true } })
      .select('requestId requestType listing user contact startDate endDate totalPrice fulfilment deliveryAddress deliveryCoordinates deliveryCharge deliveryQuote vehicleSnapshot status createdAt updatedAt propertyDecision hiddenFromAdmin')
      .populate({ path: 'listing', select: 'title name type category kind image gallery location price phone owner host hostingDetailsVersion available availability status interestUnavailable',
        populate: { path: 'host', select: 'name email' } })
      .populate('user', 'name email').sort({ createdAt: -1, _id: -1 }).lean();
    res.json(rows.filter(row => kind !== 'vehicle' || row.requestType === 'vehicle' || row.listing?.type === 'vehicle'));
  } catch { res.status(503).json({ message: 'Unable to load requests. Please try again.' }); }
});

// Capture the complete section, independently of frontend filters/pagination.
router.get('/requests/archived-set', adminProtect, async (req, res) => {
  const kind = req.query.type;
  if (!['vehicle', 'property_visit'].includes(kind)) return res.status(400).json({ message: 'Choose vehicle bookings or property visits.' });
  try {
    const filter = kind === 'vehicle' ? { $or: [{ requestType: 'vehicle' }, { requestType: { $exists: false } }] } : { requestType: 'property_visit' };
    const rows = await Booking.find({ ...filter, hiddenFromAdmin: true, adminHidden: { $ne: true } })
      .select('_id requestType listing').populate('listing', 'type').lean();
    const ids = rows.filter(row => kind !== 'vehicle' || row.requestType === 'vehicle' || row.listing?.type === 'vehicle').map(row => String(row._id));
    res.json({ type: kind, ids, count: ids.length });
  } catch { res.status(503).json({ message: 'Unable to prepare archived requests. Please retry.' }); }
});

// Bounded batches keep payloads small; each transaction rechecks archive/type state.
router.put('/requests/hide-archived', adminProtect, async (req, res) => {
  const { type, ids } = req.body || {};
  if (!['vehicle', 'property_visit'].includes(type) || !Array.isArray(ids) || !ids.length || ids.length > 200 ||
      ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length || Object.keys(req.body).some(key => !['type', 'ids'].includes(key))) {
    return res.status(400).json({ message: 'Provide a request type and 1–200 unique valid archived request IDs per batch.' });
  }
  try {
    const result = await mongoose.connection.transaction(async session => {
      const filter = type === 'vehicle' ? { $or: [{ requestType: 'vehicle' }, { requestType: { $exists: false } }] } : { requestType: 'property_visit' };
      const rows = await Booking.find({ ...filter, _id: { $in: ids }, hiddenFromAdmin: true, adminHidden: { $ne: true } })
        .select('_id requestType listing').session(session).populate('listing', 'type').lean();
      const eligible = rows.filter(row => type !== 'vehicle' || row.requestType === 'vehicle' || row.listing?.type === 'vehicle');
      const succeeded = eligible.map(row => String(row._id));
      if (eligible.length) await Booking.collection.updateMany({ _id: { $in: eligible.map(row => row._id) }, hiddenFromAdmin: true, adminHidden: { $ne: true } },
        { $set: { adminHidden: true } }, { session }); // Native update preserves every history timestamp.
      const changed = new Set(succeeded);
      return { succeeded, failed: ids.filter(id => !changed.has(id.toLowerCase())).map(id => ({ id, message: 'Request is no longer archived in this section, is already hidden, or was not found.' })) };
    });
    res.json(result);
  } catch { res.status(503).json({ message: 'Unable to hide archived requests. Refresh and retry; no batch success was confirmed.' }); }
});

router.put('/requests/:id/archive', adminProtect, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: 'Request not found.' });
  if (typeof req.body?.archived !== 'boolean' || Object.keys(req.body).length !== 1) return res.status(400).json({ message: 'Provide an archived boolean.' });
  try {
    const row = await Booking.findOne({ _id: req.params.id, adminHidden: { $ne: true } }).select('status requestType listing');
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    if (!['vehicle', 'property_visit'].includes(row.requestType)) {
      const listing = await Listing.findById(row.listing).select('type');
      if (row.requestType !== undefined || listing?.type !== 'vehicle') return res.status(400).json({ message: 'Only vehicle bookings and property visits can be archived here.' });
    }
    if (req.body.archived && !Booking.schema.path('status').enumValues.includes(row.status)) return res.status(409).json({ message: 'Requests with an invalid status cannot be archived.' });
    // Native update deliberately bypasses Mongoose timestamps. This flag must
    // never change booking history, date blocking, interest or notifications.
    const changed = await Booking.collection.updateOne({ _id: row._id, adminHidden: { $ne: true }, ...(req.body.archived ? { status: row.status } : {}) }, { $set: { hiddenFromAdmin: req.body.archived } });
    if (!changed.matchedCount) return res.status(409).json({ message: 'Request changed. Please refresh and retry.' });
    res.json({ _id: String(row._id), archived: req.body.archived });
  } catch { res.status(503).json({ message: 'Unable to archive or restore the request. Please retry.' }); }
});

router.put('/requests/:id/:action', adminProtect, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: 'Request not found.' });
  if (!['confirm', 'reject'].includes(req.params.action)) return res.status(400).json({ message: 'Choose Accept or Reject.' });
  try {
    const row = await Booking.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    const listing = await Listing.findById(row.listing).select('type');
    const visit = row.requestType === 'property_visit';
    if (!visit && (listing?.type !== 'vehicle' || ![undefined, 'vehicle'].includes(row.requestType))) {
      return res.status(400).json({ message: 'Only vehicle bookings and property visits can be managed here.' });
    }
    const status = req.params.action === 'confirm' ? 'confirmed' : 'rejected';
    const result = visit ? await decidePropertyVisit(row._id, req.user, status, { requirePending: true })
      : status === 'confirmed' ? await confirmVehicleBooking(row._id, req.user, { requirePending: true })
      : await rejectVehicleBooking(row._id, req.user);
    res.json(result);
  } catch (error) {
    res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to save this decision. Please retry.' });
  }
});

router.get('/stats', adminProtect, async (req, res) => {
  try {
    const [totalUsers, totalProducts, totalVehicles, totalRooms, totalBookings, categories, kinds, recentProducts, userUploadedProductsCount] = await Promise.all([
      User.countDocuments(), Listing.countDocuments(activeListings), Listing.countDocuments({ ...activeListings, type: 'vehicle' }),
      Listing.countDocuments({ ...activeListings, type: 'property' }), Booking.countDocuments(),
      Listing.distinct('category', activeListings), Listing.distinct('kind', activeListings),
      Listing.find(activeListings).populate('host', 'name email role').sort({ createdAt: -1 }).limit(5),
      Listing.countDocuments({ ...activeListings, host: { $ne: null } })
    ]);
    res.json({ totalUsers, totalProducts, totalVehicles, totalRooms, totalBookings,
      totalCategories: new Set([...categories, ...kinds].filter(Boolean)).size, recentProducts, userUploadedProductsCount });
  } catch { res.status(503).json({ message: 'Unable to load database statistics.' }); }
});
router.get('/users', adminProtect, async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(await Promise.all(users.map(async user => ({ ...user.toObject(),
      productCount: await Listing.countDocuments({ ...activeListings, host: user._id }) }))));
  } catch { res.status(503).json({ message: 'Unable to load users.' }); }
});

// DELETE /api/admin/users/:id - Cascade delete user and all uploaded products & images
router.delete('/users/:id', adminProtect, async (req, res) => {
  try {
    const userId = req.params.id;
    const userDoc = await User.findById(userId);
    if (!userDoc) return res.status(404).json({ message: 'User not found' });

    if (userDoc.role === 'admin' && req.user._id.toString() === userId) {
      return res.status(400).json({ message: 'Admin cannot delete their own account from admin panel' });
    }

    const userListings = await mongoose.connection.transaction(async session => {
      // Shared listing locks prevent a racing request from losing its reference.
      await Listing.updateMany({ host: userId }, { $inc: { bookingRevision: 1 } }, { session });
      const listings = await Listing.find({ host: userId }).session(session);
      if (await Booking.exists({ $or: [{ user: userId }, { listing: { $in: listings.map(row => row._id) } }] }).session(session)) {
        throw Object.assign(new Error('This account has booking history and cannot be deleted.'), { status: 409 });
      }
      if (await User.exists({ savedListings: { $in: listings.map(row => row._id) } }).session(session)) {
        throw Object.assign(new Error('This account has saved-listing references and cannot be deleted.'), { status: 409 });
      }
      await Listing.deleteMany({ host: userId }, { session });
      await User.findByIdAndDelete(userId, { session });
      return listings;
    });
    for (const listing of userListings) await deleteListingFiles(listing);

    res.json({ message: `User ${userDoc.name} and all associated products were deleted successfully.` });
  } catch (error) {
    res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to delete user safely.' });
  }
});

router.get('/listings', adminProtect, async (req, res) => {
  try { res.json(await Listing.find(activeListings).populate('host', 'name email role').sort({ createdAt: -1 })); }
  catch { res.status(503).json({ message: 'Unable to load listings.' }); }
});

// DELETE /api/admin/listings/:id - Delete product by Admin
router.delete('/listings/:id', adminProtect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ message: 'Listing not found' });

    await removeListing(listing);
    res.json({ message: 'Listing deleted successfully by admin' });
  } catch (error) {
    res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to remove listing safely.' });
  }
});

// ---------- STEP 5: Admin reviews the owner ----------

// GET /api/admin/owners - List every owner onboarding application (any step/status)
router.get('/owners', adminProtect, async (req, res) => {
  try {
    const combined = await User.find({ $or: [{ role: 'owner' }, { 'ownerProfile.status': { $nin: ['not_started', null] } }] }).select('-password').lean();
    // Pending applications surface first so admins can action them quickly.
    const statusRank = { pending: 0, in_progress: 1, approved: 2, rejected: 3 };
    combined.sort((a, b) => (statusRank[a.ownerProfile?.status] ?? 4) - (statusRank[b.ownerProfile?.status] ?? 4));

    res.json(combined);
  } catch (error) {
    console.error('Error fetching owner applications:', error.message);
    res.status(503).json({ message: 'Unable to load owner applications.' });
  }
});

// PUT /api/admin/owners/:id/approve - Approve an owner application
router.put('/owners/:id/approve', adminProtect, async (req, res) => {
  try {
    const id = req.params.id;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      const user = await User.findById(id);
      if (user) {
        if (user.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be changed through owner review.' });
        if (user.ownerProfile?.status !== 'pending') return res.status(409).json({ message: 'Only submitted pending owner applications can be approved.' });
        user.ownerProfile = {
          ...(user.ownerProfile?.toObject?.() || {}),
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: req.user.name || 'Admin',
          reviewNote: ''
        };
        user.role = 'owner';
        await user.save();
        return res.json({ message: `${user.name}'s owner application was approved.`, ownerProfile: user.ownerProfile });
      }
    }

    // Fallback / offline-mode application, keyed by email (id is the email in that case)
    const app = upsertOwnerApp(id, { status: 'approved', reviewedAt: new Date(), reviewedBy: req.user.name || 'Admin', reviewNote: '' });
    res.json({ message: `${app.name || app.email}'s owner application was approved.`, ownerProfile: app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/owners/:id/revoke', adminProtect, async (req, res) => {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: 'Owner not found.' });
    const user = await mongoose.connection.transaction(async session => {
      const target = await User.findById(req.params.id).session(session);
      if (!target) throw Object.assign(new Error('Owner not found.'), { status: 404 });
      if (target.role === 'admin') throw Object.assign(new Error('Admin access cannot be revoked through owner review.'), { status: 400 });
      if (target.role !== 'owner' || target.ownerProfile?.status !== 'approved') throw Object.assign(new Error('Only approved owners can be revoked.'), { status: 409 });
      target.role = 'user'; target.ownerProfile.status = 'revoked'; target.ownerProfile.reviewedAt = new Date(); target.ownerProfile.reviewedBy = req.user.name;
      await target.save({ session });
      await Listing.updateMany({ host: target._id }, { $set: { available: false, availability: 'Unavailable', interestUnavailable: false }, $inc: { bookingRevision: 1 } }, { session });
      return target;
    });
    res.json({ message: 'Owner access revoked. Existing records and reservations are preserved.', ownerProfile: user.ownerProfile });
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to revoke owner access safely. Please retry.' }); }
});

// PUT /api/admin/owners/:id/reject - Reject an owner application with an optional note
router.put('/owners/:id/reject', adminProtect, async (req, res) => {
  try {
    const id = req.params.id;
    const { note } = req.body;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      const user = await User.findById(id);
      if (user) {
        if (user.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be changed through owner review.' });
        user.ownerProfile = {
          ...(user.ownerProfile?.toObject?.() || {}),
          status: 'rejected',
          reviewedAt: new Date(),
          reviewedBy: req.user.name || 'Admin',
          reviewNote: note || 'Application did not meet requirements.'
        };
        await user.save();
        return res.json({ message: `${user.name}'s owner application was rejected.`, ownerProfile: user.ownerProfile });
      }
    }

    const app = upsertOwnerApp(id, { status: 'rejected', reviewedAt: new Date(), reviewedBy: req.user.name || 'Admin', reviewNote: note || 'Application did not meet requirements.' });
    res.json({ message: `${app.name || app.email}'s owner application was rejected.`, ownerProfile: app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/admin/bookings
router.get('/bookings', adminProtect, async (req, res) => {
  try {
    const bookings = await Booking.find({})
      .populate('user', 'id name email')
      .populate('listing', 'id title name type');
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;

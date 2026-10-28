import express from 'express';
import { removeListing } from '../utils/listingHistory.js';
import { uploadDirectory } from '../utils/uploadPaths.js';
import mongoose from 'mongoose';
import Listing from '../models/Listing.js';
import User from '../models/User.js';
import { verifyToken, sessionIsCurrent } from '../utils/tokens.js';
import multer from 'multer';
import { finished } from 'node:stream/promises';
import { deleteListingFiles, mapUploadedFiles, saveListingImages, assertListingImageReferences } from '../utils/uploadImages.js';
import { assertListingManager, assertPublisher, assertHostingType, listingUpdate } from '../utils/workflowPolicy.js';
import { publicCatalogFilter } from '../utils/stagingPublicCatalog.js';
import Booking from '../models/Booking.js';
import { bookingDates, confirmedOverlapFilter, withVehicleBookingStatus } from '../utils/vehicleBookings.js';
import { todayInIndia } from '../utils/requestDates.js';
import { validateHosting } from '../../src/data/hosting.js';
import { coordinateValue } from '../../src/data/coordinates.js';
import { hostingLocationChanged } from '../../src/data/hosting.js';
import { deliveryArea, withinArea } from '../utils/deliveryQuotes.js';
import { syncPropertyInterestAvailability } from '../utils/propertyInterestAvailability.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(), // Verify bytes before writing any public upload.
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(Object.assign(new Error('Only image files are allowed!'), { status: 400 }), false);
  }
});

const fastQuery = (promise, ms = 800) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), ms))
  ]);
};

const validId = value => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
const mutationError = (res, error) => res.status(error.status ||
  (['ValidationError', 'CastError'].includes(error.name) ? 400 : 503)).json({
  message: error.status || ['ValidationError', 'CastError'].includes(error.name)
    ? error.message : 'The database operation could not be completed. Please reload before retrying.'
});

// Ending a multipart response while the browser/proxy is still writing the body
// can reset the connection. Discard rejected uploads without parsing, buffering,
// or writing files, then send the original authorization/error response.
async function rejectUploadRequest(req, res, status, message) {
  if (req.is('multipart/form-data') && !req.readableEnded) {
    try {
      const drained = finished(req, { cleanup: true });
      req.resume();
      await drained;
    } catch {
      // An aborted connection cannot receive a response.
      return;
    }
  }
  if (!res.destroyed) return res.status(status).json({ message });
}

async function managedListing(id, actor) {
  if (!validId(id)) throw Object.assign(new Error('Listing not found.'), { status: 404 });
  const listing = await Listing.findById(id).maxTimeMS(5000);
  if (!listing || listing.archivedAt) throw Object.assign(new Error('Listing not found.'), { status: 404 });
  assertListingManager(actor, listing);
  return listing;
}

// Strict authentication: a valid JWT for a user that exists in the database is required.
// There is no dummy-token path and no fallback/borrowed identity.
const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return rejectUploadRequest(req, res, 401, 'Not authorized, please log in.');
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (jwtErr) {
    return rejectUploadRequest(req, res, 401, 'Not authorized, invalid or expired token.');
  }

  if (!decoded || !decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
    return rejectUploadRequest(req, res, 401, 'Not authorized, invalid token.');
  }

  if (mongoose.connection.readyState !== 1) {
    return rejectUploadRequest(req, res, 503, 'Service temporarily unavailable. Please try again shortly.');
  }

  try {
    const user = await fastQuery(User.findById(decoded.id).select('-password'), 5000);
    if (!user || !sessionIsCurrent(decoded, user)) {
      return rejectUploadRequest(req, res, 401, 'Not authorized, user no longer exists.');
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error('Auth lookup failed in listings protect:', err.message);
    return rejectUploadRequest(req, res, 503, 'Service temporarily unavailable. Please try again shortly.');
  }
};

export { deleteListingFiles } from '../utils/uploadImages.js';

// GET /api/listings - Get all listings or search/filter
router.get('/', async (req, res) => {
  try {
    const type = req.query.type;
    const category = req.query.category;
    const q = (req.query.q || '').toLowerCase();

    let mongoListings = [];
    if (mongoose.connection.readyState === 1) {
      try {
        const query = { ...publicCatalogFilter(mongoose.connection.name), publicationState: { $ne: 'draft' }, archivedAt: { $exists: false }, $and: [] };
        if (type) query.type = type;
        if (category && category !== 'All') {
          query.$and.push({ $or: [{ category }, { kind: category }] });
        }
        if (q) {
          const regex = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
          query.$and.push({ $or: [
            { title: regex },
            { name: regex },
            { location: regex },
            { category: regex }
          ] });
        }

        if (!query.$and.length) delete query.$and;
        mongoListings = await Listing.find(query).populate('host', 'name email').sort({ createdAt: -1 }).maxTimeMS(2000);
      } catch (err) {
        return res.status(503).json({ message: 'Listings are temporarily unavailable.' });
      }
    }

    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Listings are temporarily unavailable.' });
    res.json(await withVehicleBookingStatus(mongoListings));
  } catch (error) {
    res.status(503).json({ message: 'Listings are temporarily unavailable.' });
  }
});

// GET /api/listings/mine - Get current user's uploaded listings
router.get('/mine', protect, async (req, res) => {
  try {
    const currentUserIdStr = req.user._id.toString();

    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Unable to load your listings. Please try again.' });
    const mongoListings = await Listing.find({
      archivedAt: { $exists: false },
      $or: [
        { host: req.user._id },
        { host: currentUserIdStr }
      ]
    }).sort({ createdAt: -1 }).maxTimeMS(2000);

    res.json(mongoListings);
  } catch (error) {
    res.status(503).json({ message: 'Unable to load your listings. Please try again.' });
  }
});

router.get('/:id/availability', (req, res, next) => req.query.manage === 'true' ? protect(req, res, next) : next(), async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: 'Vehicle not found.' });
    const listing = await Listing.findOne({ _id: req.params.id, type: 'vehicle', archivedAt: { $exists: false }, publicationState: { $ne: 'draft' } });
    if (!listing) return res.status(404).json({ message: 'Vehicle not found.' });
    const managing = req.query.manage === 'true';
    if (managing && (req.user.role !== 'owner' || req.user.ownerProfile?.status !== 'approved' || String(listing.host) !== String(req.user._id))) return res.status(403).json({ message: 'Only the verified vehicle owner may manage its calendar.' });
    const from = req.query.from || todayInIndia();
    const to = req.query.to || new Date(new Date(from + 'T00:00:00Z').getTime() + 42 * 86400000).toISOString().slice(0, 10);
    const dates = bookingDates(from, to);
    if (dates.days > 366) return res.status(400).json({ message: 'Choose a calendar range of at most 366 days.' });
    const rows = await Booking.find(confirmedOverlapFilter(listing._id, dates.start, dates.end)).select(managing ? 'startDate endDate _id' : 'startDate endDate -_id').sort({ startDate: 1 }).lean();
    const summary = await withVehicleBookingStatus(listing);
    res.json({ listingId: String(listing._id), from, to,
      vehicleBookingStatus: summary.vehicleBookingStatus,
      available: listing.available !== false && listing.status === 'available' && !/unavailable|not available|rented|booked/i.test(listing.availability || '') && !/^(unavailable|rented|booked)$/i.test(listing.badge || ''),
      bookedRanges: rows });
  } catch (error) { res.status(error.status || 400).json({ message: error.status ? error.message : 'Unable to load vehicle availability.' }); }
});

router.put('/:id/availability', protect, async (req, res) => {
  try {
    if (typeof req.body?.available !== 'boolean' || Object.keys(req.body).length !== 1) return res.status(400).json({ message: 'Provide an available boolean.' });
    const listing = await managedListing(req.params.id, req.user);
    const available = req.body.available;
    if (available && await User.exists({ _id: listing.host, 'ownerProfile.status': 'revoked' })) throw Object.assign(new Error('Owner access is revoked. Review the owner application before making this listing available.'), { status: 409 });
    if (listing.type === 'property') {
      const updated = await mongoose.connection.transaction(async session => {
        if (available && await User.exists({ _id: listing.host, 'ownerProfile.status': 'revoked' }).session(session)) throw Object.assign(new Error('Owner access is revoked. This listing must remain unavailable.'), { status: 409 });
        const current = await Listing.findOneAndUpdate({ _id: listing._id, host: listing.host, archivedAt: { $exists: false } },
          { $set: { available, status: 'available', availability: available ? 'Available now' : 'Unavailable', interestUnavailable: false }, $inc: { bookingRevision: 1 } },
          { session, returnDocument: 'after', runValidators: true });
        if (!current) throw Object.assign(new Error('Listing changed. Please refresh.'), { status: 409 });
        return current;
      });
      return res.json(updated);
    }
    const updated = await Listing.findOneAndUpdate({ _id: listing._id, host: listing.host, updatedAt: listing.updatedAt, archivedAt: { $exists: false } },
      { $set: { available, status: 'available', availability: available ? 'Available now' : 'Unavailable',
        ...(listing.type === 'vehicle' && /^(unavailable|rented|booked)$/i.test(listing.badge || '') ? { badge: available ? 'Available' : 'Unavailable' } : {}) }, $inc: { bookingRevision: 1 } },
      { returnDocument: 'after', runValidators: true });
    if (!updated) return res.status(409).json({ message: 'Listing changed. Please refresh.' });
    res.json(updated);
  } catch (error) { return mutationError(res, error); }
});

// GET /api/listings/:id
router.get('/:id', async (req, res) => {
  try {
    const targetId = req.params.id;

    if (mongoose.connection.readyState === 1) {
      try {
        const listing = await Listing.findById(targetId).populate('host', 'name email').maxTimeMS(2000);
        if (listing && !listing.archivedAt && listing.publicationState !== 'draft') {
          return res.json(await withVehicleBookingStatus(listing));
        }
      } catch (err) {}
    }

    res.status(404).json({ message: 'Listing not found' });
  } catch (error) {
    res.status(404).json({ message: 'Listing not found' });
  }
});

async function validateHostingArea(req, coordinates) {
  const point = coordinateValue(coordinates);
  if (!point) throw Object.assign(new Error('Choose a valid location on the map before publishing.'), { status: 400 });
  let area;
  try { area = await (req.app.locals.deliveryQuoteServices?.area || (() => deliveryArea()))(); }
  catch { throw Object.assign(new Error('Listing service-area validation is unavailable. Please retry.'), { status: 503 }); }
  if (!withinArea(point, area.polygons)) throw Object.assign(new Error('This location is outside the RentSphere service area. Please choose a supported location on the map.'), { status: 422 });
}

// POST /api/listings - Create a new listing with optional multi-image upload
const publisherOnly = (req, res, next) => {
  try { assertPublisher(req.user); if (req.body?.type) assertHostingType(req.user, req.body.type); return next(); }
  catch (error) { return rejectUploadRequest(req, res, error.status, error.message); }
};

router.post('/validate-location', protect, publisherOnly, async (req, res) => {
  try { await validateHostingArea(req, req.body?.locationCoordinates); res.json({ valid: true }); }
  catch (error) { mutationError(res, error); }
});

const listingImages = upload.array('images', 10);
const uploadListingImages = (req, res, next) => {
  listingImages(req, res, error => {
    if (!error) return saveListingImages(req.files, req.app.locals.listingUploadDirectory || uploadDirectory).then(() => next(), async error => {
      await discardNewUploads(req);
      return rejectUploadRequest(req, res, error.status || 503, error.status ? error.message : 'Image upload is temporarily unavailable. Please try again.');
    });
    const isLimitError = error instanceof multer.MulterError;
    const status = isLimitError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      : error.status || (error.code ? 503 : 400);
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller.'
      : status === 503 ? 'Image upload is temporarily unavailable. Please try again.' : error.message;
    return rejectUploadRequest(req, res, status, message);
  });
};

function hostingBody(req) {
  const body = { ...req.body };
  for (const key of ['gallery', 'amenities', 'features', 'locationCoordinates']) {
    if (typeof body[key] === 'string') {
      try { body[key] = JSON.parse(body[key]); }
      catch { throw Object.assign(new Error(`Invalid ${key}.`), { status: 400 }); }
    }
  }
  if (!body.title && body.name) body.title = body.name;
  return body;
}

// Only new files from this request are eligible for cleanup on failed saves.
// Existing listing/gallery files are never removed by an edit.
async function discardNewUploads(req) {
  await deleteListingFiles({ gallery: mapUploadedFiles((req.files || []).filter(file => file.filename)) }, req.app.locals.listingUploadDirectory ? { findUpload: filename => ({ path: `${req.app.locals.listingUploadDirectory}/${filename}` }) } : {});
}

router.post('/', protect, publisherOnly, uploadListingImages, async (req, res) => {
  try {
    const body = hostingBody(req);
    if (!['number', 'string'].includes(typeof body.price) || (typeof body.price === 'string' && !body.price.trim()) ||
        !Number.isFinite(Number(body.price)) || Number(body.price) < 0) {
      throw Object.assign(new Error('A valid non-negative listing price is required.'), { status: 400 });
    }
    assertHostingType(req.user, body.type);
    const fields = validateHosting(body);
    await validateHostingArea(req, fields.locationCoordinates);
    if (fields.locationCoordinates === null) delete fields.locationCoordinates;
    if (body.gallery !== undefined) listingUpdate({ gallery: body.gallery });
    const fileImages = mapUploadedFiles(req.files || []);
    const uploadedImages = [...(body.gallery || (fileImages.length ? [] : body.image ? [body.image] : [])), ...fileImages];
    if (!uploadedImages.length || uploadedImages.length > 10) throw Object.assign(new Error('Choose between 1 and 10 images.'), { status: 400 });
    // Validate explicit upload references before they can reach file cleanup.
    if (uploadedImages.length) listingUpdate({ gallery: uploadedImages });

    const title = fields.title;
    const name = fields.title;
    const isProperty = body.type === 'property';

    const hostUser = {
      _id: req.user._id,
      name: req.user.name || 'Demo User',
      email: req.user.email || 'user@example.com'
    };

    const listingData = {
      ...fields,
      hostingDetailsVersion: 1,
      title,
      name,
      type: body.type,
      image: uploadedImages[0],
      gallery: uploadedImages,
      host: req.user._id,
      rating: 0,
      availability: isProperty ? 'Available now' : undefined,
      status: 'available',
      badge: !isProperty ? 'New' : undefined,
    };

    // Await the actual write: never turn a failed/slow save into a temporary
    // listing with a synthetic ID and a misleading permanent-success response.
    const listing = await mongoose.connection.transaction(async session => {
      const actor = await User.findOneAndUpdate({ _id: req.user._id, role: req.user.role, ...(req.user.role === 'admin' ? {} : { 'ownerProfile.status': 'approved' }) }, { $inc: { hostingRevision: 1 } }, { session, returnDocument: 'after' });
      if (!actor) throw Object.assign(new Error('Hosting access changed. Please refresh your account.'), { status: 403 });
      assertHostingType(actor, body.type);
      await assertListingImageReferences(uploadedImages, actor, { uploaded: fileImages, session });
      const [created] = await Listing.create([listingData], { session });
      return created;
    });
    return res.status(201).json({ ...listing.toObject(), host: hostUser });
  } catch (error) {
    await discardNewUploads(req);
    return mutationError(res, error);
  }
});

// POST /api/listings/:id/rent - the listing host/admin marks a property rented.
// Property-only: vehicles use the existing vehicle booking flow and are never marked rented here.
router.post('/:id/rent', protect, async (req, res) => {
  try {
    const existing = await managedListing(req.params.id, req.user);
    const vehicleOnly = { message: 'Only properties can be confirmed as rented after a visit.' };
    const rentedValues = { status: 'rented', availability: 'Currently Rented', interestUnavailable: false };
    if (existing.type !== 'property') return res.status(400).json(vehicleOnly);
    const listing = await Listing.findOneAndUpdate(
      { _id: existing._id, host: existing.host, type: 'property', status: 'available' },
      { $set: rentedValues }, { returnDocument: 'after', runValidators: true }
    ).populate('host', 'name email');
    if (!listing) return res.status(409).json({ message: 'Listing is no longer available. Please reload.' });
    return res.json(listing);
  } catch (error) {
    return mutationError(res, error);
  }
});

// PUT /api/listings/:id
const authorizeEdit = async (req, res, next) => {
  try { req.managedListing = await managedListing(req.params.id, req.user); assertHostingType(req.user, req.managedListing.type); next(); }
  catch (error) { return rejectUploadRequest(req, res, error.status || 503, error.status ? error.message : 'Unable to load listing.'); }
};
router.put('/:id', protect, authorizeEdit, uploadListingImages, async (req, res) => {
  try {
    const listing = req.managedListing;
    const body = hostingBody(req);
    const fields = validateHosting(body, { partial: true, type: listing.type, kind: body.kind || listing.kind || (['Bike', 'Scooter'].includes(listing.category) ? 'Bike' : 'Car') });
    if (listing.type === 'vehicle' && body.kind !== undefined && body.category === undefined) {
      validateHosting({ category: listing.category }, { partial: true, type: 'vehicle', kind: body.kind });
    }
    const update = listingUpdate({ ...body, ...fields });
    // A changed text address without a replacement pin explicitly clears stale coordinates.
    if (body.location !== undefined && body.location.trim() !== listing.location && body.locationCoordinates === undefined) update.locationCoordinates = null;
    if (body.locationCoordinates !== undefined && body.location === undefined) throw Object.assign(new Error('Provide the address together with its selected coordinates.'), { status: 400 });
    if (hostingLocationChanged({ location: update.location ?? listing.location, locationCoordinates: update.locationCoordinates === undefined ? listing.locationCoordinates : update.locationCoordinates }, listing)) await validateHostingArea(req, update.locationCoordinates === undefined ? listing.locationCoordinates : update.locationCoordinates);
    const clearCoordinates = update.locationCoordinates === null;
    if (clearCoordinates) delete update.locationCoordinates;
    if (update.title !== undefined) update.name = update.title;
    const uploads = mapUploadedFiles(req.files || []);
    if (req.is('multipart/form-data')) {
      const existing = new Set([listing.image, ...(listing.gallery || [])].filter(Boolean));
      const retained = update.gallery || [...existing];
      if (retained.some(url => !existing.has(url))) throw Object.assign(new Error('Retain only existing listing images.'), { status: 400 });
      update.gallery = [...new Set([...retained, ...uploads])];
      if (!update.gallery.length || update.gallery.length > 10) throw Object.assign(new Error('Choose between 1 and 10 images.'), { status: 400 });
      update.image = update.gallery[0];
      // A complete form save opts this listing into its full owner-managed gallery.
      if (body.title !== undefined && body.phone !== undefined) {
        validateHosting(body, { type: listing.type, kind: body.kind || listing.kind });
        update.hostingDetailsVersion = 1;
      }
    }
    if (update.status === 'rented' && listing.type !== 'property') {
      throw Object.assign(new Error('Only properties can be marked rented.'), { status: 400 });
    }
    if ((update.status === 'available' || (update.availability !== undefined && !/unavailable|not available|rented/i.test(update.availability))) && await User.exists({ _id: listing.host, 'ownerProfile.status': 'revoked' })) throw Object.assign(new Error('Owner access is revoked. This listing must remain unavailable.'), { status: 409 });
    if (update.status) update.availability = update.status === 'rented' ? 'Currently Rented' : 'Available now';
    if (listing.type === 'property' && update.availability !== undefined) {
      const updated = await mongoose.connection.transaction(async session => {
        await assertListingImageReferences([update.image, ...(update.gallery || [])], req.user, { listing, uploaded: uploads, session });
        const current = await Listing.findOneAndUpdate(
          { _id: listing._id, host: listing.host, updatedAt: listing.updatedAt, archivedAt: { $exists: false } },
          { $set: { ...update, interestUnavailable: false } }, { session, returnDocument: 'after', runValidators: true });
        if (!current) throw Object.assign(new Error('Listing changed. Please reload before retrying.'), { status: 409 });
        return syncPropertyInterestAvailability(mongoose.connection.db, current.toObject(), session);
      });
      return res.json(updated);
    }
    const updated = await mongoose.connection.transaction(async session => {
      await assertListingImageReferences([update.image, ...(update.gallery || [])], req.user, { listing, uploaded: uploads, session });
      return Listing.findOneAndUpdate(
      { _id: listing._id, host: listing.host, updatedAt: listing.updatedAt, archivedAt: { $exists: false } },
      { $set: update, ...(clearCoordinates ? { $unset: { locationCoordinates: '' } } : {}) }, { session, returnDocument: 'after', runValidators: true }
      );
    });
    if (!updated) throw Object.assign(new Error('Listing changed. Please reload before retrying.'), { status: 409 });
    return res.json(updated);
  } catch (error) {
    await discardNewUploads(req);
    return mutationError(res, error);
  }
});

// DELETE /api/listings/:id - Delete listing with image cleanup
router.delete('/:id', protect, async (req, res) => {
  try {
    const listing = await managedListing(req.params.id, req.user);
    await removeListing(listing);
    return res.json({ message: 'Listing removed successfully' });
  } catch (error) {
    return mutationError(res, error);
  }
});

export default router;

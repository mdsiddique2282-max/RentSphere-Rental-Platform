import express from 'express';
import { coordinateValue } from '../../src/data/coordinates.js';
import Booking from '../models/Booking.js';
import Listing from '../models/Listing.js';
import User from '../models/User.js';
import { verifyToken, sessionIsCurrent } from '../utils/tokens.js';
import { bookingDates, bookingPrice, assertVehicleAvailable, confirmVehicleBooking, rejectVehicleBooking, releaseVehicleBooking } from '../utils/vehicleBookings.js';
import mongoose from 'mongoose';
import { assertRequestTransition } from '../utils/workflowPolicy.js';
import { assertNotPastDate } from '../utils/requestDates.js';
import { createHash } from 'node:crypto';
import { assertPropertyAvailable, decidePropertyVisit } from '../utils/propertyVisits.js';
import { assertPublisher } from '../utils/workflowPolicy.js';
import { syncPropertyInterestAvailability } from '../utils/propertyInterestAvailability.js';
import { createDeliveryQuote, reviewedDeliveryQuote, deliveryArea, deliveryError } from '../utils/deliveryQuotes.js';

const router = express.Router();

const isValidObjectIdString = (value) =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);


// ===============================
// AUTHENTICATION
// ===============================
// A valid JWT for an existing database user is required. Bookings are always tied to
// that authenticated user - never to "the first user in the database" or a made-up one.
const protect = async (req, res, next) => {
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

  if (!decoded || !isValidObjectIdString(decoded.id)) {
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
    req.user = user;
    return next();
  } catch (error) {
    console.error('Auth lookup failed in bookings protect:', error.message);
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }
};


// ===============================
// GET MY BOOKINGS
// ===============================
router.get('/mybookings', protect, async (req, res) => {
  try {
    const bookings = await Booking.find({
      user: req.user._id, hiddenFromCustomer: { $ne: true }
    }).populate('listing').sort({ createdAt: -1, _id: -1 });

    res.json(bookings);

  } catch (error) {
    console.error('Get bookings error:', error.message);

    res.status(500).json({
      message: error.message
    });
  }
});


// ===============================
// CREATE BOOKING
// ===============================
const quoteServices = req => req.app.locals.deliveryQuoteServices || {};
const areaFor = req => (quoteServices(req).area || (() => deliveryArea()))();
router.post('/delivery-quote', protect, async (req, res) => {
  try {
    const { listingId, startDate, endDate, deliveryCoordinates, deliveryAddress, fallback = false } = req.body || {};
    if (!isValidObjectIdString(listingId) || typeof fallback !== 'boolean') throw deliveryError(400, 'INVALID_REQUEST', 'Provide a valid vehicle and calculation request.');
    const dates = bookingDates(startDate, endDate); assertNotPastDate(dates.start);
    const destination = coordinateValue(deliveryCoordinates);
    if (!destination || typeof deliveryAddress !== 'string' || !deliveryAddress.trim() || deliveryAddress.length > 500) throw deliveryError(400, 'DELIVERY_LOCATION_REQUIRED', 'Select and confirm a complete delivery location before calculating.');
    const listing = await Listing.findOne({ _id: listingId, type: 'vehicle', archivedAt: { $exists: false }, publicationState: { $ne: 'draft' } });
    if (!listing) throw deliveryError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found.');
    if (!listing.locationCoordinates) throw deliveryError(400, 'PICKUP_LOCATION_MISSING', 'This vehicle has no confirmed map location. Ask its owner/admin to choose a pickup location; Self Pickup remains available.');
    coordinateValue(listing.locationCoordinates);
    if (listing.available === false || listing.status !== 'available' || /unavailable|not available|rented|booked/i.test(listing.availability || '') || /^(unavailable|rented|booked)$/i.test(listing.badge || '')) throw deliveryError(409, 'VEHICLE_UNAVAILABLE', 'This vehicle is unavailable.');
    await assertVehicleAvailable(listing._id, dates.start, dates.end);
    const area = await areaFor(req);
    res.json(await createDeliveryQuote({ userId: req.user._id, listing, dates, destination, address: deliveryAddress, fallback, ...quoteServices(req), area }));
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Delivery calculation is temporarily unavailable. Please retry.', code: error.code || 'QUOTE_UNAVAILABLE', fallbackAllowed: error.fallbackAllowed === true }); }
});

const createRequest = (isVisit = false) => async (req, res) => {
  try {

    const {
      listingId,
      startDate,
      endDate,
      fulfilment,
      deliveryAddress
    } = req.body || {};

    // --- Listing: must be a real MongoDB id of a listing that exists ---
    if (!isValidObjectIdString(listingId)) {
      return res.status(400).json({
        message: 'A valid listing ID is required. Only listings stored in the database can be booked.'
      });
    }

    const dates = bookingDates(startDate, isVisit ? startDate : endDate);
    assertNotPastDate(dates.start);

    // --- Fulfilment ---
    const mode = isVisit ? 'pickup' : fulfilment === undefined ? 'pickup' : fulfilment;
    if (mode !== 'pickup' && mode !== 'delivery') {
      return res.status(400).json({
        message: "Fulfilment must be either 'pickup' or 'delivery'."
      });
    }

    if (mode === 'delivery') {
      if (typeof deliveryAddress !== 'string' || !deliveryAddress.trim()) {
        return res.status(400).json({
          message: 'Delivery address is required for home delivery.'
        });
      }
    }
    const deliveryCoordinates = req.body.deliveryCoordinates === undefined ? undefined : coordinateValue(req.body.deliveryCoordinates);
    if (deliveryCoordinates && (isVisit || mode !== 'delivery')) return res.status(400).json({ message: 'Delivery coordinates apply only to Home Delivery bookings.' });

    // --- The listing must actually exist: never create a booking pointing at a fake reference ---
    const listing = await Listing.findById(listingId);
    if (!listing || listing.archivedAt || listing.publicationState === 'draft') {
      return res.status(404).json({
        message: 'Listing not found.'
      });
    }
    if (deliveryCoordinates && listing.type !== 'vehicle') return res.status(400).json({ message: 'Delivery coordinates apply only to vehicle Home Delivery bookings.' });

    if (isVisit && listing.type !== 'property') {
      return res.status(400).json({ message: 'Visit requests are only available for properties.' });
    }
    if (!['vehicle', 'property'].includes(listing.type)) {
      return res.status(400).json({ message: 'This listing cannot accept requests.' });
    }
    if (listing.type === 'property') assertPropertyAvailable(listing);
    if (listing.type === 'vehicle' && (listing.available === false || listing.status !== 'available' ||
        /^(unavailable|rented|booked)$/i.test(listing.availability || '') || /^(unavailable|rented|booked)$/i.test(listing.badge || ''))) {
      return res.status(409).json({ message: 'This vehicle is unavailable for new requests.' });
    }

    const requestType = isVisit ? 'property_visit' : listing.type === 'vehicle' ? 'vehicle' : 'property_booking';
    const submissionKey = createHash('sha256').update(JSON.stringify([
      String(req.user._id), String(listing._id), requestType,
      dates.start.toISOString(), dates.end.toISOString(),
    ])).digest('hex');
    // Wait for the unique indexes before accepting concurrent submissions.
    await Booking.init();
    // Include pre-Phase-2 bookings that do not have a submission key/type yet;
    // no migration or rewriting of those records is needed.
    const duplicate = {
      user: req.user._id, listing: listing._id,
      startDate: dates.start, endDate: dates.end,
      status: { $in: ['pending', 'confirmed'] },
      ...(isVisit ? { requestType } : { $or: [{ requestType }, { requestType: { $exists: false } }] }),
    };
    if (await Booking.exists(duplicate)) {
      return res.status(409).json({ message: 'You already have a request for this listing on these dates.' });
    }
    let contact;
    if (req.body.contact !== undefined) {
      const input = req.body.contact;
      if (!input || ['name', 'email', 'phone'].some(key =>
        typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 254)) {
        return res.status(400).json({ message: 'Valid customer contact details are required.' });
      }
      contact = { name: input.name.trim(), email: input.email.trim(), phone: input.phone.trim() };
    }

    const quotedDelivery = listing.type === 'vehicle' && mode === 'delivery';
    if (quotedDelivery && !req.body.deliveryQuoteId) throw deliveryError(400, 'DELIVERY_QUOTE_REQUIRED', 'Calculate and review a delivery quote before submitting this booking.');
    const area = quotedDelivery ? await areaFor(req) : null;
    const quote = quotedDelivery ? await reviewedDeliveryQuote({ quoteId: req.body.deliveryQuoteId, userId: req.user._id, listing, dates, destination: deliveryCoordinates, address: deliveryAddress, area }) : null;
    const price = quote ? { totalPrice: quote.totalPrice, deliveryCharge: quote.deliveryCharge } : isVisit ? { totalPrice: 0, deliveryCharge: 0 } : bookingPrice(listing, dates, mode);
    if (listing.type === 'vehicle') {
      await assertVehicleAvailable(listing._id, dates.start, dates.end);
    }

    const booking = new Booking({
      ...(listing.inventoryKind === 'sample' ? { inventoryKind: 'sample', sampleDisclosure: listing.sampleDisclosure } : {}),
      requestType, submissionKey, contact, status: 'pending',
      user: req.user._id,
      listing: listing._id,
      startDate: dates.start,
      endDate: dates.end,
      ...price,
      fulfilment: mode,
      deliveryAddress: mode === 'delivery' ? deliveryAddress.trim() : undefined,
      ...(deliveryCoordinates ? { deliveryCoordinates } : {}),
      ...(quote ? { deliveryQuote: quote } : {})
    });

    const createdBooking = await mongoose.connection.transaction(async session => {
      // Serialize creation against renting, archival and owner decisions.
      const current = await Listing.findOneAndUpdate({ _id: listing._id,
        archivedAt: { $exists: false }, publicationState: { $ne: 'draft' } },
      { $inc: { bookingRevision: 1 } }, { session, returnDocument: 'after' });
      if (!current) throw Object.assign(new Error('Listing is no longer available.'), { status: 409 });
      if (current.type === 'property') assertPropertyAvailable(current);
      if (current.type === 'vehicle' && (current.available === false || current.status !== 'available' ||
          /^(unavailable|rented|booked)$/i.test(current.availability || '') || /^(unavailable|rented|booked)$/i.test(current.badge || ''))) {
        throw Object.assign(new Error('This vehicle is unavailable for new requests.'), { status: 409 });
      }
      if (current.type === 'vehicle') await assertVehicleAvailable(current._id, dates.start, dates.end, { session });
      const checkedQuote = quotedDelivery ? await reviewedDeliveryQuote({ quoteId: req.body.deliveryQuoteId, userId: req.user._id, listing: current, dates, destination: deliveryCoordinates, address: deliveryAddress, area, session }) : null;
      const saved = new Booking({ ...booking.toObject(),
        ...(current.type === 'vehicle' ? { vehicleSnapshot: { name: current.title || current.name, pickupAddress: current.location,
          ...(current.locationCoordinates ? { pickupCoordinates: coordinateValue(current.locationCoordinates) } : {}) } } : {}),
        ...(checkedQuote ? { totalPrice: checkedQuote.totalPrice, deliveryCharge: checkedQuote.deliveryCharge, deliveryQuote: checkedQuote } : isVisit ? {} : bookingPrice(current, dates, mode)) });
      return saved.save({ session });
    });

    res.status(201).json(createdBooking);

  } catch (error) {

    if (error.code === 11000) {
      return res.status(409).json({ message: 'You already have a request for this listing on these dates.' });
    }

    console.error('Create booking error:', error.message);

    res.status(error.status || 500).json({
      message: error.status ? error.message : 'Unable to create booking. Please try again.'
    });
  }
};

router.post('/', protect, createRequest());
router.post('/visits', protect, createRequest(true));

router.get('/owner/requests', protect, async (req, res) => {
  try {
    assertPublisher(req.user);
    const ids = await Listing.find(req.user.role === 'admin' ? {} : { host: req.user._id }).distinct('_id');
    res.json(await Booking.find({ listing: { $in: ids }, ...(req.user.role === 'owner' ? { hiddenFromOwners: { $ne: req.user._id } } : {}) }).populate('listing').populate('user', 'name email').sort({ createdAt: -1, _id: -1 }));
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to load requests.' }); }
});

// Owner-scoped visit inbox; admins may inspect all property visits.
router.get('/owner/visits', protect, async (req, res) => {
  try {
    assertPublisher(req.user);
    const ids = await Listing.find(req.user.role === 'admin' ? { type: 'property' } :
      { type: 'property', host: req.user._id }).distinct('_id');
    res.json(await Booking.find({ requestType: 'property_visit', listing: { $in: ids }, ...(req.user.role === 'owner' ? { hiddenFromOwners: { $ne: req.user._id } } : {}) })
      .populate('listing').populate('user', 'name email').sort({ createdAt: -1, _id: -1 }));
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to load visits.' }); }
});

router.put('/:id/reject', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ message: 'Booking not found.' });
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    res.json(booking.requestType === 'property_visit' ? await decidePropertyVisit(req.params.id, req.user, 'rejected') : await rejectVehicleBooking(req.params.id, req.user));
  }
  catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to reject visit.' }); }
});

// Confirmation is restricted to the listing host/admin and serialized in MongoDB.
// Creating a request continues to leave it pending, as before.
router.put('/:id/confirm', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) {
    return res.status(404).json({ message: 'Booking not found.' });
  }
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    res.json(booking.requestType === 'property_visit'
      ? await decidePropertyVisit(req.params.id, req.user, 'confirmed')
      : await confirmVehicleBooking(req.params.id, req.user));
  } catch (error) {
    res.status(error.status || 503).json({
      message: error.status ? error.message : 'Unable to confirm booking safely. Please try again later.'
    });
  }
});


// ===============================
// CANCEL BOOKING
// ===============================
router.put('/:id/cancel', protect, async (req, res) => {
  try {

    if (!isValidObjectIdString(req.params.id)) {
      return res.status(404).json({
        message: 'Booking not found'
      });
    }

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        message: 'Booking not found'
      });
    }

    assertRequestTransition({ kind: 'vehicle', from: booking.status, to: 'cancelled',
      actor: req.user, customerId: booking.user });
    if (booking.requestType === 'property_visit') {
      const cancelled = await mongoose.connection.transaction(async session => {
        const current = await Booking.findById(booking._id).session(session);
        assertRequestTransition({ kind: 'property_visit', from: current.status, to: 'cancelled',
          actor: req.user, customerId: current.user });
        const listing = await Listing.findById(current.listing).session(session);
        current.status = 'cancelled';
        await current.save({ session });
        if (listing) await syncPropertyInterestAvailability(mongoose.connection.db, listing.toObject(), session);
        return current;
      });
      return res.json(cancelled);
    }
    // Compare-and-set: a concurrent cancellation/decision must not be overwritten
    // using a stale document read. Transactional confirmation retries on conflict.
    const cancelled = await Booking.findOneAndUpdate(
      { _id: booking._id, user: req.user._id, status: booking.status },
      { $set: { status: 'cancelled' } }, { returnDocument: 'after', runValidators: true }
    );
    if (!cancelled) return res.status(409).json({ message: 'Request status changed. Please reload.' });
    res.json(cancelled);

  } catch (error) {

    console.error('Cancel booking error:', error.message);

    res.status(error.status || 503).json({
      message: error.status ? error.message : 'Unable to cancel booking. Please reload before retrying.'
    });
  }
});

// Bulk removal changes only the existing visibility fields, independently in each direction.
router.put('/hide-all', protect, async (req, res) => {
  try {
    const { ids, direction, kind } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(id => !isValidObjectIdString(id)) ||
        new Set(ids).size !== ids.length || !['customer', 'owner'].includes(direction) || !['all', 'vehicle', 'property'].includes(kind)) {
      return res.status(400).json({ message: 'Select valid requests and a dashboard category.' });
    }
    if (direction === 'owner') {
      assertPublisher(req.user);
      if (req.user.role !== 'owner') return res.status(403).json({ message: 'Only the verified listing owner may hide incoming requests.' });
    }
    const listings = await Listing.find({ ...(direction === 'owner' ? { host: req.user._id } : {}), ...(kind !== 'all' ? { type: kind } : {}) }).distinct('_id');
    const category = kind === 'all' ? {} : kind === 'property'
      ? { $or: [{ requestType: { $in: ['property_visit', 'property_booking'] } }, { listing: { $in: listings } }] }
      : { requestType: { $nin: ['property_visit', 'property_booking'] }, $or: [{ listing: { $in: listings } }, { requestType: 'vehicle' }] };
    const filter = { _id: { $in: ids }, ...category, ...(direction === 'customer' ? { user: req.user._id } : { listing: { $in: listings } }) };
    if (await Booking.countDocuments(filter) !== ids.length) return res.status(403).json({ message: 'Some selected requests are outside your dashboard or category. Refresh and retry.' });
    await Booking.updateMany(filter, direction === 'customer' ? { $set: { hiddenFromCustomer: true } } : { $addToSet: { hiddenFromOwners: req.user._id } });
    res.json({ hiddenIds: ids });
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to remove requests. Refresh and retry safely.' }); }
});

router.put('/:id/release-dates', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ message: 'Booking not found.' });
  try { res.json(await releaseVehicleBooking(req.params.id, req.user, req.body?.selectedDate)); }
  catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to release dates safely. Please refresh and retry.' }); }
});

// Personal visibility only. Never delete or change the request's rental status.
router.put('/:id/hide', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ message: 'Request not found.' });
  try {
    const row = await Booking.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    if (String(row.user) !== String(req.user._id)) return res.status(403).json({ message: 'Only the request creator can remove it from personal history.' });
    const hidden = await Booking.findOneAndUpdate({ _id: row._id, user: req.user._id },
      { $set: { hiddenFromCustomer: true } }, { returnDocument: 'after', runValidators: true });
    if (!hidden) return res.status(409).json({ message: 'Request changed. Please refresh your history.' });
    res.json({ _id: hidden._id, hiddenFromCustomer: true });
  } catch { res.status(503).json({ message: 'Unable to remove request from history. Please try again.' }); }
});

router.put('/:id/hide-owner', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ message: 'Request not found.' });
  try {
    assertPublisher(req.user);
    if (req.user.role !== 'owner') return res.status(403).json({ message: 'Only the verified listing owner may hide this request.' });
    const row = await Booking.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    const listing = await Listing.findById(row.listing);
    if (!listing || String(listing.host) !== String(req.user._id)) return res.status(403).json({ message: 'Only the listing owner may hide this request.' });
    if (!['confirmed', 'rejected', 'cancelled'].includes(row.status)) return res.status(409).json({ message: 'Decide pending requests before removing them.' });
    const hidden = await Booking.findOneAndUpdate({ _id: row._id, listing: listing._id, status: { $in: ['confirmed', 'rejected', 'cancelled'] } },
      { $addToSet: { hiddenFromOwners: req.user._id } }, { returnDocument: 'after', runValidators: true });
    if (!hidden) return res.status(409).json({ message: 'Request changed. Please refresh.' });
    res.json({ _id: hidden._id, hiddenFromOwner: true });
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to remove owner request. Please retry.' }); }
});

// Only decisions written by the current workflow are eligible; no historical backfill.
router.get('/notifications', protect, async (req, res) => {
  try {
    const rows = await Booking.find({ user: req.user._id, status: { $in: ['confirmed', 'rejected', 'cancelled'] },
      'ownerDecision.decidedAt': { $exists: true }, 'ownerDecision.dismissedAt': { $exists: false },
      $expr: { $eq: ['$status', '$ownerDecision.status'] } })
      .select('requestType status startDate endDate ownerDecision listing')
      .populate('listing', 'title name type phone host legacyId catalogKey inventoryKind hostingDetailsVersion')
      .sort({ 'ownerDecision.decidedAt': -1 });
    res.json(rows);
  } catch { res.status(503).json({ message: 'Unable to load your request updates. Please retry.' }); }
});

router.put('/:id/dismiss-notification', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) return res.status(404).json({ message: 'Request not found.' });
  try {
    const row = await Booking.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Request not found.' });
    if (String(row.user) !== String(req.user._id)) return res.status(403).json({ message: 'Only the request creator can dismiss this update.' });
    if (!row.ownerDecision?.decidedAt) return res.status(409).json({ message: 'This request has no new decision notification.' });
    const updated = await Booking.findOneAndUpdate({ _id: row._id, user: req.user._id, 'ownerDecision.decidedAt': row.ownerDecision.decidedAt },
      { $set: { 'ownerDecision.dismissedAt': new Date() } }, { returnDocument: 'after', runValidators: true });
    if (!updated) return res.status(409).json({ message: 'Decision changed. Please refresh.' });
    res.json({ _id: updated._id, dismissed: true });
  } catch { res.status(503).json({ message: 'Unable to dismiss this update. Please retry.' }); }
});


export default router;

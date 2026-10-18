import express from 'express';
import Booking from '../models/Booking.js';
import Listing from '../models/Listing.js';
import User from '../models/User.js';
import { verifyToken } from '../utils/tokens.js';
import { bookingDates, bookingPrice, assertVehicleAvailable, confirmVehicleBooking } from '../utils/vehicleBookings.js';
import mongoose from 'mongoose';

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
    if (!user) {
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
      user: req.user._id
    }).populate('listing');

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
router.post('/', protect, async (req, res) => {
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

    const dates = bookingDates(startDate, endDate);

    // --- Fulfilment ---
    const mode = fulfilment === undefined ? 'pickup' : fulfilment;
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

    // --- The listing must actually exist: never create a booking pointing at a fake reference ---
    const listing = await Listing.findById(listingId).select('_id type price');
    if (!listing) {
      return res.status(404).json({
        message: 'Listing not found.'
      });
    }

    const price = bookingPrice(listing, dates, mode);
    if (listing.type === 'vehicle') {
      await assertVehicleAvailable(listing._id, dates.start, dates.end);
    }

    const booking = new Booking({
      user: req.user._id,
      listing: listing._id,
      startDate: dates.start,
      endDate: dates.end,
      ...price,
      fulfilment: mode,
      deliveryAddress: mode === 'delivery' ? deliveryAddress.trim() : undefined
    });

    const createdBooking = await booking.save();

    res.status(201).json(createdBooking);

  } catch (error) {

    console.error('Create booking error:', error.message);

    res.status(error.status || 500).json({
      message: error.status ? error.message : 'Unable to create booking. Please try again.'
    });
  }
});

// Confirmation is restricted to the listing host/admin and serialized in MongoDB.
// Creating a request continues to leave it pending, as before.
router.put('/:id/confirm', protect, async (req, res) => {
  if (!isValidObjectIdString(req.params.id)) {
    return res.status(404).json({ message: 'Booking not found.' });
  }
  try {
    res.json(await confirmVehicleBooking(req.params.id, req.user));
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

    if (booking.user.toString() !== req.user._id.toString()) {
      return res.status(401).json({
        message: 'Not authorized'
      });
    }

    booking.status = 'cancelled';

    await booking.save();

    res.json(booking);

  } catch (error) {

    console.error('Cancel booking error:', error.message);

    res.status(500).json({
      message: error.message
    });
  }
});


export default router;

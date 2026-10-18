import express from 'express';
import mongoose from 'mongoose';
import Listing from '../models/Listing.js';
import User from '../models/User.js';
import { verifyToken } from '../utils/tokens.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { deleteListingFiles, isServerless, mapUploadedFiles } from '../utils/uploadImages.js';

const router = express.Router();

const storage = isServerless()
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination(req, file, cb) {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

const fastQuery = (promise, ms = 800) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), ms))
  ]);
};

// In-memory fallback listings store
const inMemoryListings = [];

// Strict authentication: a valid JWT for a user that exists in the database is required.
// There is no dummy-token path and no fallback/borrowed identity.
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

  if (!decoded || !decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
    return res.status(401).json({ message: 'Not authorized, invalid token.' });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }

  try {
    const user = await fastQuery(User.findById(decoded.id).select('-password'), 5000);
    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user no longer exists.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    console.error('Auth lookup failed in listings protect:', err.message);
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }
};

export { deleteListingFiles } from '../utils/uploadImages.js';

// GET /api/listings - Get all listings or search/filter
router.get('/', async (req, res) => {
  try {
    const type = req.query.type;
    const category = req.query.category;
    const q = (req.query.q || '').toLowerCase();

    const filterList = (items) => {
      return items.filter(item => {
        if (type && item.type !== type) return false;
        if (category && category !== 'All') {
          const itemCat = item.category || item.kind;
          if (itemCat !== category && item.type !== category) return false;
        }
        if (q) {
          const text = (`${item.title || item.name || ''} ${item.location || ''} ${item.category || ''}`).toLowerCase();
          if (!text.includes(q)) return false;
        }
        return true;
      });
    };

    let mongoListings = [];
    if (mongoose.connection.readyState === 1) {
      try {
        const query = {};
        if (type) query.type = type;
        if (category && category !== 'All') {
          query.$or = [{ category }, { kind: category }];
        }
        if (q) {
          const regex = { $regex: q, $options: 'i' };
          query.$or = [
            { title: regex },
            { name: regex },
            { location: regex },
            { category: regex }
          ];
        }

        mongoListings = await Listing.find(query).populate('host', 'name email').sort({ createdAt: -1 }).maxTimeMS(2000);
      } catch (err) {
        console.warn('MongoDB query warning in GET /api/listings:', err.message);
      }
    }

    const filteredInMemory = filterList(inMemoryListings);
    const mongoIds = new Set(mongoListings.map(item => item._id.toString()));
    const combined = [
      ...mongoListings,
      ...filteredInMemory.filter(item => !mongoIds.has(item._id?.toString() || item.id))
    ];

    res.json(combined);
  } catch (error) {
    res.json(inMemoryListings);
  }
});

// GET /api/listings/mine - Get current user's uploaded listings
router.get('/mine', protect, async (req, res) => {
  try {
    const currentUserIdStr = req.user._id.toString();

    let mongoListings = [];
    if (mongoose.connection.readyState === 1) {
      try {
        mongoListings = await Listing.find({
          $or: [
            { host: req.user._id },
            { host: currentUserIdStr }
          ]
        }).sort({ createdAt: -1 }).maxTimeMS(2000);
      } catch (err) {
        console.warn('MongoDB query warning in GET /api/listings/mine:', err.message);
      }
    }

    const userInMemory = inMemoryListings.filter(item => {
      if (!item.host) return true;
      const hostId = typeof item.host === 'object' ? item.host._id?.toString() : item.host.toString();
      return hostId === currentUserIdStr || item.host?.email === req.user.email;
    });

    const mongoIds = new Set(mongoListings.map(item => item._id.toString()));
    const combined = [
      ...mongoListings,
      ...userInMemory.filter(item => !mongoIds.has(item._id?.toString() || item.id))
    ];

    res.json(combined);
  } catch (error) {
    res.json([]);
  }
});

// GET /api/listings/:id
router.get('/:id', async (req, res) => {
  try {
    const targetId = req.params.id;

    const memMatch = inMemoryListings.find(item => item._id?.toString() === targetId || item.id === targetId);
    if (memMatch) {
      return res.json(memMatch);
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const listing = await Listing.findById(targetId).populate('host', 'name email').maxTimeMS(2000);
        if (listing) {
          return res.json(listing);
        }
      } catch (err) {}
    }

    res.status(404).json({ message: 'Listing not found' });
  } catch (error) {
    res.status(404).json({ message: 'Listing not found' });
  }
});

// POST /api/listings - Create a new listing with optional multi-image upload
router.post('/', protect, upload.array('images', 10), async (req, res) => {
  try {
    const body = req.body;
    let uploadedImages = [];

    if (req.files && req.files.length > 0) {
      uploadedImages = mapUploadedFiles(req.files);
    } else if (body.image) {
      uploadedImages = [body.image];
    }

    const title = body.title || body.name || 'Untitled Listing';
    const name = body.name || body.title || 'Untitled Listing';
    const isProperty = body.type === 'property';

    const hostUser = {
      _id: req.user._id,
      name: req.user.name || 'Demo User',
      email: req.user.email || 'user@example.com'
    };

    const listingData = {
      title,
      name,
      type: body.type || 'property',
      category: body.category || (isProperty ? 'Apartment' : 'Car'),
      location: body.location,
      price: Number(body.price),
      description: body.description,
      image: uploadedImages[0] || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1200&q=85',
      gallery: uploadedImages.length > 0 ? uploadedImages : [uploadedImages[0] || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1200&q=85'],
      host: req.user._id,
      rating: 4.5,
      availability: isProperty ? 'Available now' : undefined,
      status: 'available',
      badge: !isProperty ? 'New' : undefined,
      bhk: body.bhk ? Number(body.bhk) : (isProperty ? 2 : undefined),
      area: body.area ? Number(body.area) : (isProperty ? 850 : undefined),
      furnishing: body.furnishing || (isProperty ? 'Semi-furnished' : undefined),
      floor: body.floor || (isProperty ? '2nd floor' : undefined),
      fuel: body.fuel || (!isProperty ? 'Petrol' : undefined),
      transmission: body.transmission || (!isProperty ? 'Manual' : undefined),
      seats: body.seats ? Number(body.seats) : (!isProperty ? 5 : undefined),
      amenities: body.amenities ? (typeof body.amenities === 'string' ? JSON.parse(body.amenities) : body.amenities) : (isProperty ? ['Parking', 'Security', 'WiFi'] : []),
      features: body.features ? (typeof body.features === 'string' ? JSON.parse(body.features) : body.features) : (!isProperty ? ['Air conditioning', 'GPS navigation', 'Sanitized'] : [])
    };

    let createdListing = null;

    if (mongoose.connection.readyState === 1) {
      try {
        const listing = new Listing(listingData);
        createdListing = await fastQuery(listing.save());
      } catch (saveErr) {
        console.warn('MongoDB save fallback:', saveErr.message);
      }
    }

    if (!createdListing) {
      createdListing = {
        ...listingData,
        _id: `${Date.now()}-${Math.round(Math.random() * 100000)}`,
        host: hostUser,
        createdAt: new Date().toISOString()
      };
    } else {
      createdListing = createdListing.toObject();
      createdListing.host = hostUser;
    }

    inMemoryListings.unshift(createdListing);

    return res.status(201).json(createdListing);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/listings/:id/rent - a renter confirms a PROPERTY after their visit.
// Property-only: vehicles use the existing vehicle booking flow and are never marked rented here.
router.post('/:id/rent', async (req, res) => {
  try {
    const targetId = req.params.id;
    const vehicleOnly = { message: 'Only properties can be confirmed as rented after a visit.' };
    const rentedValues = { status: 'rented', availability: 'Currently Rented' };
    const memIndex = inMemoryListings.findIndex(item => item._id?.toString() === targetId || item.id === targetId);

    if (memIndex !== -1) {
      const listing = inMemoryListings[memIndex];
      if (listing.type === 'vehicle') return res.status(400).json(vehicleOnly);
      if (listing.status === 'rented') return res.status(409).json({ message: 'This listing is already rented' });
      Object.assign(listing, rentedValues);
      return res.json(listing);
    }

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(targetId)) {
      const listing = await Listing.findOneAndUpdate(
        { _id: targetId, type: { $ne: 'vehicle' }, status: { $ne: 'rented' } },
        { $set: rentedValues },
        { new: true }
      ).populate('host', 'name email');

      if (listing) return res.json(listing);

      const existing = await Listing.findById(targetId).select('type status');
      if (existing?.type === 'vehicle') return res.status(400).json(vehicleOnly);
      if (existing?.status === 'rented') return res.status(409).json({ message: 'This listing is already rented' });
    }

    return res.status(404).json({ message: 'Listing not found' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// PUT /api/listings/:id
router.put('/:id', protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    const memIndex = inMemoryListings.findIndex(item => item._id?.toString() === targetId || item.id === targetId);
    if (memIndex !== -1) {
      Object.assign(inMemoryListings[memIndex], req.body);
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const listing = await Listing.findById(targetId);
        if (listing) {
          if (listing.host.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Not authorized to update this listing' });
          }
          Object.assign(listing, req.body);
          const updatedListing = await listing.save();
          return res.json(updatedListing);
        }
      } catch (err) {}
    }
    
    if (memIndex !== -1) {
      return res.json(inMemoryListings[memIndex]);
    }

    res.status(404).json({ message: 'Listing not found' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/listings/:id - Delete listing with image cleanup
router.delete('/:id', protect, async (req, res) => {
  try {
    const targetId = req.params.id;

    const hostIdOf = (host) => (host && host._id ? host._id : host)?.toString();
    const canDelete = (host) => req.user.role === 'admin' || hostIdOf(host) === req.user._id.toString();

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(targetId)) {
      const existing = await Listing.findById(targetId).select('host');
      if (existing && !canDelete(existing.host)) {
        return res.status(403).json({ message: 'Not authorized to delete this listing' });
      }
    }
    const memCandidate = inMemoryListings.find(item => item._id?.toString() === targetId || item.id === targetId);
    if (memCandidate && !canDelete(memCandidate.host)) {
      return res.status(403).json({ message: 'Not authorized to delete this listing' });
    }

    const memIndex = inMemoryListings.findIndex(item => item._id?.toString() === targetId || item.id === targetId);
    let memItem = null;
    if (memIndex !== -1) {
      memItem = inMemoryListings.splice(memIndex, 1)[0];
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const listing = await Listing.findById(targetId);
        if (listing) {
          deleteListingFiles(listing);
          await Listing.findByIdAndDelete(targetId);
        }
      } catch (err) {}
    } else if (memItem) {
      deleteListingFiles(memItem);
    }

    res.json({ message: 'Listing removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;

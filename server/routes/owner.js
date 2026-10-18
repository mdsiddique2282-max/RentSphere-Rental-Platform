import express from 'express';
import mongoose from 'mongoose';
import { generateToken, verifyToken } from '../utils/tokens.js';
import multer from 'multer';
import User from '../models/User.js';
import { storeOwnerDocuments, serveOwnerDocument } from '../utils/ownerDocuments.js';
import { getOwnerApp, upsertOwnerApp } from '../utils/ownerStore.js';

const router = express.Router();

const fastQuery = (promise, ms = 800) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout')), ms))
  ]);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only image or PDF files are allowed!'), false);
  }
});

// Strict authentication: a valid JWT for a user that exists in the database is required.
// There is no dummy-token path and no shared demo identity.
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
    console.error('Auth lookup failed in owner protect:', err.message);
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
  }
};

router.get('/documents/:ownerId/:index', protect, serveOwnerDocument);

// Merge whatever is in Mongo (source of truth when connected) with the
// in-memory fallback record for the same email, so the response always
// reflects the fullest picture available.
const buildOwnerView = async (mongoUser, email) => {
  const fallback = getOwnerApp(email) || {};
  if (mongoUser && mongoUser.ownerProfile) {
    return {
      _id: mongoUser._id,
      name: mongoUser.name,
      email: mongoUser.email,
      role: mongoUser.role,
      ownerProfile: mongoUser.ownerProfile
    };
  }
  return {
    _id: fallback._id || 'dummy',
    name: fallback.name || 'Demo Owner',
    email,
    role: 'owner',
    ownerProfile: {
      phone: fallback.phone || '',
      businessName: fallback.businessName || '',
      address: fallback.address || '',
      city: fallback.city || '',
      state: fallback.state || '',
      bio: fallback.bio || '',
      listingIntent: fallback.listingIntent || '',
      idProofType: fallback.idProofType || '',
      idProofNumber: fallback.idProofNumber || '',
      documents: fallback.documents || [],
      currentStep: fallback.currentStep || 1,
      status: fallback.status || 'not_started',
      submittedAt: fallback.submittedAt || null,
      reviewedAt: fallback.reviewedAt || null,
      reviewNote: fallback.reviewNote || ''
    }
  };
};

// ---------- STEP 1: Owner Registration ----------
// Creates a brand-new account with role 'owner' and starts the onboarding
// wizard at step 2 (Owner Profile). If the person is registering with an
// email that already exists as a plain 'user', they should log in and use
// POST /api/owner/start instead.
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
        !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
    }

    const userExists = await fastQuery(User.findOne({ email }));
    if (userExists) {
      return res.status(400).json({ message: 'An account with this email already exists. Please log in and continue onboarding from your dashboard.' });
    }

    const user = await fastQuery(User.create({
      name,
      email,
      password,
      role: 'owner',
      ownerProfile: {
        phone: phone || '',
        currentStep: 2,
        status: 'in_progress'
      }
    }));

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id),
      ownerProfile: user.ownerProfile
    });
  } catch (error) {
    console.error('Owner register error:', error.message);
    res.status(500).json({ message: 'Could not start owner registration. Please try again.' });
  }
});

// ---------- Upgrade an already logged-in account to Owner (skips Step 1) ----------
router.post('/start', protect, async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(req.user._id)) {
      const user = await fastQuery(User.findById(req.user._id));
      if (user) {
        if (user.role !== 'admin') user.role = 'owner';
        if (!user.ownerProfile || user.ownerProfile.status === 'not_started') {
          user.ownerProfile = { ...(user.ownerProfile?.toObject?.() || {}), currentStep: 2, status: 'in_progress' };
        }
        await user.save();
        return res.json({
          _id: user._id, name: user.name, email: user.email, role: user.role,
          token: generateToken(user._id), ownerProfile: user.ownerProfile
        });
      }
    }

    return res.status(404).json({ message: 'Account not found.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ---------- Fetch current onboarding status (used to resume the wizard / dashboard badge) ----------
router.get('/me', protect, async (req, res) => {
  try {
    let mongoUser = null;
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(req.user._id)) {
      mongoUser = await fastQuery(User.findById(req.user._id));
    }
    const view = await buildOwnerView(mongoUser, req.user.email);
    res.json(view);
  } catch (error) {
    res.json({
      _id: req.user._id, name: req.user.name, email: req.user.email, role: 'owner',
      ownerProfile: getOwnerApp(req.user.email) || { currentStep: 1, status: 'not_started', documents: [] }
    });
  }
});

// ---------- STEP 2: Owner Profile ----------
router.put('/profile', protect, async (req, res) => {
  try {
    const { phone, businessName, address, city, state, bio, listingIntent } = req.body;
    const profileUpdate = { phone, businessName, address, city, state, bio, listingIntent, currentStep: 3 };

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(req.user._id)) {
      const user = await fastQuery(User.findById(req.user._id));
      if (user) {
        user.ownerProfile = {
          ...(user.ownerProfile?.toObject?.() || {}),
          ...profileUpdate,
          status: user.ownerProfile?.status === 'not_started' ? 'in_progress' : (user.ownerProfile?.status || 'in_progress')
        };
        if (user.role !== 'admin') user.role = 'owner';
        await user.save();
        return res.json({ ownerProfile: user.ownerProfile });
      }
    }

    const app = upsertOwnerApp(req.user.email, { ...profileUpdate, status: 'in_progress' });
    res.json({ ownerProfile: app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ---------- STEP 3: Owner submits information (ID proof + supporting documents) ----------
router.post('/documents', protect, upload.array('documents', 5), async (req, res) => {
  try {
    const { idProofType, idProofNumber } = req.body;
    let uploadedDocs = [];
    if (req.files && req.files.length > 0) {
      uploadedDocs = await storeOwnerDocuments(req.files, req.user._id);
    }

    const docUpdate = {
      idProofType: idProofType || '',
      idProofNumber: idProofNumber || '',
      currentStep: 4
    };

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(req.user._id)) {
      const user = await fastQuery(User.findById(req.user._id));
      if (user) {
        const existingDocs = user.ownerProfile?.documents || [];
        user.ownerProfile = {
          ...(user.ownerProfile?.toObject?.() || {}),
          ...docUpdate,
          documents: uploadedDocs.length > 0 ? [...existingDocs, ...uploadedDocs] : existingDocs,
          status: 'in_progress'
        };
        await user.save();
        return res.json({ ownerProfile: user.ownerProfile });
      }
    }

    const existing = getOwnerApp(req.user.email);
    const existingDocs = existing?.documents || [];
    const app = upsertOwnerApp(req.user.email, {
      ...docUpdate,
      documents: uploadedDocs.length > 0 ? [...existingDocs, ...uploadedDocs] : existingDocs,
      status: 'in_progress'
    });
    res.json({ ownerProfile: app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ---------- STEP 4: Owner reviews everything and submits for Admin review (-> STEP 5) ----------
router.post('/submit', protect, async (req, res) => {
  try {
    const submissionUpdate = { status: 'pending', currentStep: 5, submittedAt: new Date(), reviewNote: '' };

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(req.user._id)) {
      const user = await fastQuery(User.findById(req.user._id));
      if (user) {
        user.ownerProfile = { ...(user.ownerProfile?.toObject?.() || {}), ...submissionUpdate };
        await user.save();
        return res.json({ ownerProfile: user.ownerProfile });
      }
    }

    const app = upsertOwnerApp(req.user.email, submissionUpdate);
    res.json({ ownerProfile: app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;

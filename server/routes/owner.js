import { ownerProfileErrors, ownerDocumentErrors, ownerFileError, validOwnerPhone } from '../../src/data/ownerPolicy.js';
import express from 'express';
import { normalizeEmail, validEmail, validNewPassword, emailFilter } from '../utils/accountValidation.js';
import mongoose from 'mongoose';
import { generateToken, verifyToken, sessionIsCurrent } from '../utils/tokens.js';
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
    if (!user || !sessionIsCurrent(decoded, user)) {
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
    const { name, email: submittedEmail, password, phone } = req.body || {};
    const email = normalizeEmail(submittedEmail);

    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
        !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });
    }

    if (!validEmail(email) || !validNewPassword(password)) return res.status(400).json({ message: 'A valid email and password of at least 6 characters (maximum 72 UTF-8 bytes) are required.' });
    if (!validOwnerPhone(phone)) return res.status(400).json({ message: 'Please enter a valid 10-digit Indian mobile number.', errors: { phone: 'Please enter a valid 10-digit Indian mobile number.' } });
    const userExists = await fastQuery(User.findOne(emailFilter(email)));
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
      token: generateToken(user._id, user.authVersion),
      ownerProfile: user.ownerProfile
    });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'An account with this email already exists.' });
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
        if (user.role === 'user' && user.ownerProfile?.status === 'approved') return res.status(409).json({ message: 'This legacy approval needs administrator review before owner access can be granted.' });
        if (user.role !== 'admin') user.role = 'owner';
        if (!user.ownerProfile || ['not_started', 'revoked'].includes(user.ownerProfile.status)) {
          user.ownerProfile = { ...(user.ownerProfile?.toObject?.() || {}), currentStep: 2, status: 'in_progress' };
        }
        await user.save();
        return res.json({
          _id: user._id, name: user.name, email: user.email, role: user.role,
          token: generateToken(user._id, user.authVersion), ownerProfile: user.ownerProfile
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


const mutableApplication = (req, res, next) => {
  if (req.user.role === 'admin' || ['pending', 'approved'].includes(req.user.ownerProfile?.status)) return res.status(409).json({ message: 'Submitted and approved applications are view-only.' });
  next();
};
const mutationFilter = user => ({ _id: user._id, role: { $ne: 'admin' }, 'ownerProfile.status': { $nin: ['pending', 'approved'] } });
const invalid = (res, errors) => res.status(400).json({ message: Object.values(errors)[0], errors });

router.put('/profile', protect, mutableApplication, async (req, res) => {
  try {
    const body = req.body || {}, errors = ownerProfileErrors(body);
    if (Object.keys(errors).length) return invalid(res, errors);
    const fields = Object.fromEntries(['phone','businessName','address','city','state','bio','listingIntent'].map(key => ['ownerProfile.' + key, typeof body[key] === 'string' ? body[key].trim() : '']));
    const user = await User.findOneAndUpdate(mutationFilter(req.user), { $set: { ...fields, role: 'owner', 'ownerProfile.status': req.user.ownerProfile?.status === 'rejected' ? 'rejected' : 'in_progress' }, $max: { 'ownerProfile.currentStep': 3 } }, { returnDocument: 'after', runValidators: true });
    if (!user) return res.status(409).json({ message: 'Application changed. Refresh before editing.' });
    res.json({ ownerProfile: user.ownerProfile });
  } catch { res.status(503).json({ message: 'Unable to save your profile. Please retry.' }); }
});

const documentsUpload = upload.array('documents', 5);
router.post('/documents', protect, mutableApplication, (req, res, next) => documentsUpload(req, res, error => error ? res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Each document must be 5 MB or smaller.' : 'Choose at most 5 image/PDF documents, up to 5 MB each.', errors: { documents: error.message } }) : next()), async (req, res) => {
  try {
    const errors = { ...ownerProfileErrors(req.user.ownerProfile), ...ownerDocumentErrors(req.body, [...(req.user.ownerProfile?.documents || []), ...(req.files || [])]) };
    const fileError = ownerFileError(req.files || []); if (fileError) errors.documents = fileError;
    if (Object.keys(errors).length) return invalid(res, errors);
    const user = await mongoose.connection.transaction(async session => {
      const current = await User.findOneAndUpdate(mutationFilter(req.user), { $set: { 'ownerProfile.idProofType': req.body.idProofType, 'ownerProfile.idProofNumber': req.body.idProofNumber.trim(), 'ownerProfile.status': req.user.ownerProfile?.status === 'rejected' ? 'rejected' : 'in_progress' }, $max: { 'ownerProfile.currentStep': 4 } }, { session, returnDocument: 'after', runValidators: true });
      if (!current) throw Object.assign(new Error('Application changed. Refresh before editing.'), { status: 409 });
      const documents = await storeOwnerDocuments(req.files || [], req.user._id, session);
      current.ownerProfile.documents.push(...documents); await current.save({ session }); return current;
    });
    res.json({ ownerProfile: user.ownerProfile });
  } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to save verification details. Please retry.' }); }
});

router.post('/submit', protect, mutableApplication, async (req, res) => {
  try {
    const errors = { ...ownerProfileErrors(req.user.ownerProfile), ...ownerDocumentErrors(req.user.ownerProfile, req.user.ownerProfile?.documents || []) };
    if (Object.keys(errors).length) return invalid(res, errors);
    const user = await User.findOneAndUpdate({ ...mutationFilter(req.user), updatedAt: req.user.updatedAt }, { $set: { 'ownerProfile.status': 'pending', 'ownerProfile.currentStep': 5, 'ownerProfile.submittedAt': new Date(), 'ownerProfile.reviewNote': '' } }, { returnDocument: 'after', runValidators: true });
    if (!user) return res.status(409).json({ message: 'Application changed. Refresh before submitting.' });
    res.json({ ownerProfile: user.ownerProfile });
  } catch { res.status(503).json({ message: 'Unable to submit your application. Please retry.' }); }
});

export default router;

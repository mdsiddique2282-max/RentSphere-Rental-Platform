import express from 'express';
import { normalizeEmail, validEmail, validNewPassword, emailFilter } from '../utils/accountValidation.js';
import { generateToken, verifyToken, sessionIsCurrent } from '../utils/tokens.js';
import User from '../models/User.js';

import mongoose from 'mongoose';

const router = express.Router();

const withTimeout = (promise, ms = 5000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
};

const dbUnavailable = (res) =>
  res.status(503).json({ message: 'Service temporarily unavailable. Please try again shortly.' });

// Read-only session refresh. Return only dashboard identity/application status,
// never password hashes, verification documents or private identity information.
router.get('/me', async (req, res) => {
  let decoded;
  try { decoded = verifyToken(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]); }
  catch { return res.status(401).json({ message: 'Please log in again.' }); }
  if (!/^[a-f\d]{24}$/i.test(String(decoded?.id))) return res.status(401).json({ message: 'Please log in again.' });
  if (mongoose.connection.readyState !== 1) return dbUnavailable(res);
  try {
    const user = await User.findById(decoded.id).select('name email role ownerProfile.status ownerProfile.reviewNote ownerProfile.currentStep ownerProfile.listingIntent authVersion').maxTimeMS(5000);
    if (!user || !sessionIsCurrent(decoded, user)) return res.status(401).json({ message: 'Please log in again.' });
    res.json({ _id: user._id, name: user.name, email: user.email, role: user.role,
      ownerProfile: { listingIntent: user.ownerProfile?.listingIntent || '', status: user.ownerProfile?.status || 'not_started', reviewNote: user.ownerProfile?.reviewNote || '', currentStep: user.ownerProfile?.currentStep || 1 } });
  } catch { return dbUnavailable(res); }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email: submittedEmail, password } = req.body || {};
    const email = normalizeEmail(submittedEmail);

    // Reject non-string values (e.g. objects like {"$ne": null}) before they reach a query.
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
        !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    if (!validEmail(email) || !validNewPassword(password)) return res.status(400).json({ message: 'A valid email and password of at least 6 characters (maximum 72 UTF-8 bytes) are required.' });

    if (mongoose.connection.readyState !== 1) return dbUnavailable(res);

    const userExists = await withTimeout(User.findOne(emailFilter(email)));
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    // Role is never taken from the request or derived from the email: new accounts are
    // always created with the schema default ('user'). Admin accounts are provisioned
    // out-of-band (e.g. server/seed.js or directly in the database).
    const user = await withTimeout(User.create({ name, email, password }));
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id, user.authVersion)
    });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'User already exists' });
    console.error('Register error:', error.message);
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email: submittedEmail, password } = req.body || {};
    const email = normalizeEmail(submittedEmail);

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    if (mongoose.connection.readyState !== 1) return dbUnavailable(res);

    if (!validEmail(email)) return res.status(400).json({ message: 'A valid email is required.' });
    const candidates = await withTimeout(User.find(emailFilter(email)));
    const exact = candidates.find(user => user.email === submittedEmail.trim());
    let user;
    if (exact && await withTimeout(exact.matchPassword(password))) user = exact;
    else {
      const matches = [];
      for (const candidate of candidates) if (await withTimeout(candidate.matchPassword(password))) matches.push(candidate);
      if (matches.length > 1) return res.status(409).json({ message: 'Email matches multiple existing accounts. Use the exact registered email casing.' });
      user = matches[0];
    }

    // Same response for "no such user" and "wrong password": no session is ever created
    // unless the stored password hash matches.
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id, user.authVersion)
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

export default router;

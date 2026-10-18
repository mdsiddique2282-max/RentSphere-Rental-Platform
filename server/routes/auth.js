import express from 'express';
import { generateToken } from '../utils/tokens.js';
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

router.post('/register', async (req, res) => {
  try {
    const { name, email: submittedEmail, password } = req.body || {};
    const email = typeof submittedEmail === 'string' ? submittedEmail.trim().toLowerCase() : submittedEmail;

    // Reject non-string values (e.g. objects like {"$ne": null}) before they reach a query.
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
        !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    if (mongoose.connection.readyState !== 1) return dbUnavailable(res);

    const userExists = await withTimeout(User.findOne({ email }));
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
      token: generateToken(user._id)
    });
  } catch (error) {
    console.error('Register error:', error.message);
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email: submittedEmail, password } = req.body || {};
    const email = typeof submittedEmail === 'string' ? submittedEmail.trim().toLowerCase() : submittedEmail;

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    if (mongoose.connection.readyState !== 1) return dbUnavailable(res);

    const user = await withTimeout(User.findOne({ email }));

    // Same response for "no such user" and "wrong password": no session is ever created
    // unless the stored password hash matches.
    if (!user || !(await withTimeout(user.matchPassword(password)))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id)
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

export default router;

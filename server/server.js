// Must be the FIRST import: loads .env before any other module (notably db.js) is
// evaluated. See server/env.js for why the order matters.
import './env.js';

import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import listingRoutes from './routes/listings.js';
import bookingRoutes from './routes/bookings.js';
import adminRoutes from './routes/admin.js';
import ownerRoutes from './routes/owner.js';
import connectDB from './db.js';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { isServerless } from './utils/uploadImages.js';
import { requireJwtSecret } from './utils/tokens.js';
import { servePublicListingUpload } from './utils/ownerDocuments.js';

// Fail at startup rather than issue or accept tokens signed with a default key.
requireJwtSecret();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, 'uploads');
if (!isServerless() && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    next();
  }
});

app.use('/uploads', servePublicListingUpload);

app.use('/api/auth', authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/owner', ownerRoutes);

if (!isServerless()) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;

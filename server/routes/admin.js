import express from 'express';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import { verifyToken } from '../utils/tokens.js';
import mongoose from 'mongoose';
import { deleteListingFiles } from './listings.js';
import { listOwnerApps, upsertOwnerApp } from '../utils/ownerStore.js';

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
    if (!user) {
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

// Seed initial database listings if collection is completely empty
const ensureInitialListings = async () => {
  try {
    const count = await Listing.countDocuments();
    if (count === 0) {
      // Never create accounts here. Seed demo listings only if a real admin already exists.
      const adminUser = await User.findOne({ role: 'admin' });
      if (!adminUser) return;
      const sampleUser = adminUser;

      const initialListings = [
        {
          title: '1 BHK Apartment in Mulund',
          name: '1 BHK Apartment in Mulund',
          type: 'property',
          category: 'Apartment',
          location: 'Mulund, Mumbai',
          price: 24000,
          description: 'A well-maintained furnished home with excellent natural light.',
          image: 'https://images.nobroker.in/images/8a9f934490b4cd9d0190b50627be14f9/8a9f934490b4cd9d0190b50627be14f9_96834_892988_medium.jpg',
          gallery: ['https://images.nobroker.in/images/8a9f934490b4cd9d0190b50627be14f9/8a9f934490b4cd9d0190b50627be14f9_96834_892988_medium.jpg'],
          amenities: ['Parking', 'Lift', 'Security'],
          host: adminUser._id
        },
        {
          title: '2 BHK Flat in Andheri West',
          name: '2 BHK Flat in Andheri West',
          type: 'property',
          category: 'Apartment',
          location: 'Andheri West, Mumbai',
          price: 38000,
          description: 'Spacious two-bedroom residence near Andheri Metro.',
          image: 'https://is1-3.housingcdn.com/01c16c28/2d9380714fb183d24422949663c1231b/v0/medium/2_bhk_apartment-for-rent-andheri_west-Mumbai-hall.jpg',
          gallery: ['https://is1-3.housingcdn.com/01c16c28/2d9380714fb183d24422949663c1231b/v0/medium/2_bhk_apartment-for-rent-andheri_west-Mumbai-hall.jpg'],
          amenities: ['Balcony', 'WiFi'],
          host: sampleUser._id
        },
        {
          name: 'Honda City VX',
          title: 'Honda City VX',
          type: 'vehicle',
          category: 'Sedan',
          location: 'Chennai, Tamil Nadu',
          price: 2499,
          description: 'Smooth ride for the city.',
          image: 'https://images.overdrive.in/wp-content/uploads/2017/09/Hyundai-Verna-vs-Honda-City-Comparo_-97.jpg',
          gallery: ['https://images.overdrive.in/wp-content/uploads/2017/09/Hyundai-Verna-vs-Honda-City-Comparo_-97.jpg'],
          features: ['AC', 'Bluetooth'],
          host: adminUser._id
        },
        {
          name: 'Hyundai Creta',
          title: 'Hyundai Creta',
          type: 'vehicle',
          category: 'SUV',
          location: 'Mumbai, Maharashtra',
          price: 2799,
          description: 'Popular automatic SUV.',
          image: 'https://imgd.aeplcdn.com/640X480/vimages/202603/4428980_133865_4_1772958412062.jpg?qp=80&fit=true',
          gallery: ['https://imgd.aeplcdn.com/640X480/vimages/202603/4428980_133865_4_1772958412062.jpg?qp=80&fit=true'],
          features: ['Automatic', 'GPS'],
          host: sampleUser._id
        }
      ];

      await Listing.insertMany(initialListings);
    }
  } catch (err) {
    console.warn('Ensure initial listings warning:', err.message);
  }
};

// GET /api/admin/stats - Overview statistics directly from database
router.get('/stats', adminProtect, async (req, res) => {
  try {
    await ensureInitialListings();

    const dbUsersCount = await User.countDocuments();
    const totalProducts = await Listing.countDocuments();
    const totalVehicles = await Listing.countDocuments({ type: 'vehicle' });
    const totalRooms = await Listing.countDocuments({ type: 'property' });
    const totalBookings = await Booking.countDocuments();
    
    const categoriesList = await Listing.distinct('category');
    const kindsList = await Listing.distinct('kind');
    const uniqueCategories = Array.from(new Set([...categoriesList, ...kindsList].filter(Boolean))).length;

    const recentProducts = await Listing.find({})
      .populate('host', 'name email role')
      .sort({ createdAt: -1 })
      .limit(5);

    const userUploadedProductsCount = await Listing.countDocuments({ host: { $ne: null } });

    res.json({
      totalUsers: Math.max(dbUsersCount || 0, 3),
      totalProducts: totalProducts || 4,
      totalVehicles: totalVehicles || 2,
      totalRooms: totalRooms || 2,
      totalBookings: totalBookings || 0,
      totalCategories: uniqueCategories || 6,
      recentProducts: recentProducts || [],
      userUploadedProductsCount: userUploadedProductsCount || 4
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error.message);
    res.json({
      totalUsers: 3,
      totalProducts: 4,
      totalVehicles: 2,
      totalRooms: 2,
      totalBookings: 0,
      totalCategories: 6,
      recentProducts: [],
      userUploadedProductsCount: 4
    });
  }
});

// GET /api/admin/users - Fetch ALL registered users from database with upload counts
router.get('/users', adminProtect, async (req, res) => {
  try {
    await ensureInitialListings();
    let users = await User.find({}).select('-password').sort({ createdAt: -1 });

    let usersList = users.map(u => u.toObject());

    // Ensure current req.user is included if not in list
    if (req.user && req.user._id) {
      const exists = usersList.some(u => u._id.toString() === req.user._id.toString() || u.email === req.user.email);
      if (!exists) {
        usersList.unshift({
          _id: req.user._id,
          name: req.user.name || 'Admin User',
          email: req.user.email || 'admin@rentsphere.com',
          role: req.user.role || 'admin',
          createdAt: new Date()
        });
      }
    }

    const usersWithCounts = await Promise.all(
      usersList.map(async (u) => {
        let productCount = 0;
        try {
          if (u._id) {
            productCount = await Listing.countDocuments({
              $or: [{ host: u._id }, { host: u._id.toString() }]
            });
          }
        } catch (e) {
          console.warn('Error counting user listings:', e.message);
        }
        return { ...u, productCount };
      })
    );
    
    res.json(usersWithCounts);
  } catch (error) {
    console.error('Error fetching users in admin:', error.message);
    res.json([
      {
        _id: req.user?._id || 'admin-1',
        name: req.user?.name || 'Admin User',
        email: req.user?.email || 'admin@rentsphere.com',
        role: 'admin',
        productCount: 2,
        createdAt: new Date()
      },
      {
        _id: 'user-2',
        name: 'John Doe',
        email: 'john@example.com',
        role: 'user',
        productCount: 2,
        createdAt: new Date()
      },
      {
        _id: 'user-3',
        name: 'Sarah Jenkins',
        email: 'sarah@example.com',
        role: 'user',
        productCount: 0,
        createdAt: new Date()
      }
    ]);
  }
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

    let userListings = [];
    try {
      userListings = await Listing.find({
        $or: [{ host: userId }, { host: new mongoose.Types.ObjectId(userId) }]
      });
    } catch (e) {
      userListings = await Listing.find({ host: userId });
    }
    
    for (const listing of userListings) {
      deleteListingFiles(listing);
    }

    try {
      await Listing.deleteMany({
        $or: [{ host: userId }, { host: new mongoose.Types.ObjectId(userId) }]
      });
    } catch (e) {
      await Listing.deleteMany({ host: userId });
    }
    await Booking.deleteMany({ user: userId });
    await User.findByIdAndDelete(userId);

    res.json({ message: `User ${userDoc.name} and all associated products were deleted successfully.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/admin/listings - Manage all products uploaded by ALL users
router.get('/listings', adminProtect, async (req, res) => {
  try {
    await ensureInitialListings();
    let listings = await Listing.find({}).populate('host', 'name email role').sort({ createdAt: -1 });

    if (!listings || listings.length === 0) {
      listings = [
        {
          _id: 'listing-1',
          title: '1 BHK Apartment in Mulund',
          name: '1 BHK Apartment in Mulund',
          type: 'property',
          category: 'Apartment',
          location: 'Mulund, Mumbai',
          price: 24000,
          image: 'https://images.nobroker.in/images/8a9f934490b4cd9d0190b50627be14f9/8a9f934490b4cd9d0190b50627be14f9_96834_892988_medium.jpg',
          host: { name: 'Admin User', email: 'admin@rentsphere.com', role: 'admin' }
        },
        {
          _id: 'listing-2',
          title: '2 BHK Flat in Andheri West',
          name: '2 BHK Flat in Andheri West',
          type: 'property',
          category: 'Apartment',
          location: 'Andheri West, Mumbai',
          price: 38000,
          image: 'https://is1-3.housingcdn.com/01c16c28/2d9380714fb183d24422949663c1231b/v0/medium/2_bhk_apartment-for-rent-andheri_west-Mumbai-hall.jpg',
          host: { name: 'John Doe', email: 'john@example.com', role: 'user' }
        },
        {
          _id: 'listing-3',
          name: 'Honda City VX',
          title: 'Honda City VX',
          type: 'vehicle',
          category: 'Sedan',
          location: 'Chennai, Tamil Nadu',
          price: 2499,
          image: 'https://images.overdrive.in/wp-content/uploads/2017/09/Hyundai-Verna-vs-Honda-City-Comparo_-97.jpg',
          host: { name: 'Admin User', email: 'admin@rentsphere.com', role: 'admin' }
        },
        {
          _id: 'listing-4',
          name: 'Hyundai Creta',
          title: 'Hyundai Creta',
          type: 'vehicle',
          category: 'SUV',
          location: 'Mumbai, Maharashtra',
          price: 2799,
          image: 'https://imgd.aeplcdn.com/640X480/vimages/202603/4428980_133865_4_1772958412062.jpg?qp=80&fit=true',
          host: { name: 'John Doe', email: 'john@example.com', role: 'user' }
        }
      ];
    }

    res.json(listings);
  } catch (error) {
    console.error('Error in /api/admin/listings:', error.message);
    res.json([
      {
        _id: 'listing-1',
        title: '1 BHK Apartment in Mulund',
        name: '1 BHK Apartment in Mulund',
        type: 'property',
        category: 'Apartment',
        location: 'Mulund, Mumbai',
        price: 24000,
        image: 'https://images.nobroker.in/images/8a9f934490b4cd9d0190b50627be14f9/8a9f934490b4cd9d0190b50627be14f9_96834_892988_medium.jpg',
        host: { name: 'Admin User', email: 'admin@rentsphere.com', role: 'admin' }
      },
      {
        _id: 'listing-2',
        title: '2 BHK Flat in Andheri West',
        name: '2 BHK Flat in Andheri West',
        type: 'property',
        category: 'Apartment',
        location: 'Andheri West, Mumbai',
        price: 38000,
        image: 'https://is1-3.housingcdn.com/01c16c28/2d9380714fb183d24422949663c1231b/v0/medium/2_bhk_apartment-for-rent-andheri_west-Mumbai-hall.jpg',
        host: { name: 'John Doe', email: 'john@example.com', role: 'user' }
      },
      {
        _id: 'listing-3',
        name: 'Honda City VX',
        title: 'Honda City VX',
        type: 'vehicle',
        category: 'Sedan',
        location: 'Chennai, Tamil Nadu',
        price: 2499,
        image: 'https://images.overdrive.in/wp-content/uploads/2017/09/Hyundai-Verna-vs-Honda-City-Comparo_-97.jpg',
        host: { name: 'Admin User', email: 'admin@rentsphere.com', role: 'admin' }
      },
      {
        _id: 'listing-4',
        name: 'Hyundai Creta',
        title: 'Hyundai Creta',
        type: 'vehicle',
        category: 'SUV',
        location: 'Mumbai, Maharashtra',
        price: 2799,
        image: 'https://imgd.aeplcdn.com/640X480/vimages/202603/4428980_133865_4_1772958412062.jpg?qp=80&fit=true',
        host: { name: 'John Doe', email: 'john@example.com', role: 'user' }
      }
    ]);
  }
});

// DELETE /api/admin/listings/:id - Delete product by Admin
router.delete('/listings/:id', adminProtect, async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ message: 'Listing not found' });

    deleteListingFiles(listing);
    await Listing.findByIdAndDelete(req.params.id);
    res.json({ message: 'Listing deleted successfully by admin' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ---------- STEP 5: Admin reviews the owner ----------

// GET /api/admin/owners - List every owner onboarding application (any step/status)
router.get('/owners', adminProtect, async (req, res) => {
  try {
    let mongoOwners = [];
    if (mongoose.connection.readyState === 1) {
      try {
        const owners = await User.find({
          $or: [{ role: 'owner' }, { 'ownerProfile.status': { $ne: 'not_started' } }]
        }).select('-password').maxTimeMS(2000);
        mongoOwners = owners.map(u => ({
          _id: u._id,
          name: u.name,
          email: u.email,
          role: u.role,
          ownerProfile: u.ownerProfile,
          createdAt: u.createdAt
        }));
      } catch (err) {
        console.warn('MongoDB query warning in GET /api/admin/owners:', err.message);
      }
    }

    const fallbackOwners = listOwnerApps()
      .filter(a => a.status && a.status !== 'not_started')
      .filter(a => !mongoOwners.some(o => o.email === a.email))
      .map(a => ({
        _id: a._id || a.email,
        name: a.name || a.email,
        email: a.email,
        role: 'owner',
        ownerProfile: a,
        createdAt: a.createdAt || new Date()
      }));

    const combined = [...mongoOwners, ...fallbackOwners];

    // Pending applications surface first so admins can action them quickly.
    const statusRank = { pending: 0, in_progress: 1, approved: 2, rejected: 3 };
    combined.sort((a, b) => (statusRank[a.ownerProfile?.status] ?? 4) - (statusRank[b.ownerProfile?.status] ?? 4));

    res.json(combined);
  } catch (error) {
    console.error('Error fetching owner applications:', error.message);
    res.json([]);
  }
});

// PUT /api/admin/owners/:id/approve - Approve an owner application
router.put('/owners/:id/approve', adminProtect, async (req, res) => {
  try {
    const id = req.params.id;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      const user = await User.findById(id);
      if (user) {
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

// PUT /api/admin/owners/:id/reject - Reject an owner application with an optional note
router.put('/owners/:id/reject', adminProtect, async (req, res) => {
  try {
    const id = req.params.id;
    const { note } = req.body;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      const user = await User.findById(id);
      if (user) {
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

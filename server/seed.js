import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';
import Listing from './models/Listing.js';
import Booking from './models/Booking.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rentsphere';

mongoose.connect(MONGODB_URI);

const seedData = async () => {
  try {
    await User.deleteMany();
    await Listing.deleteMany();
    await Booking.deleteMany();

    const admin = new User({ name: 'Admin User', email: 'admin@rentsphere.com', password: 'password', role: 'admin' });
    await admin.save();
    const john = new User({ name: 'John Doe', email: 'john@example.com', password: 'password', role: 'user' });
    await john.save();

    const adminId = admin._id;

    await Listing.insertMany([
      {
        title: 'Sunny Studio in Downtown',
        type: 'property',
        category: 'Apartment',
        location: 'Downtown, City',
        price: 15000,
        description: 'A beautiful sunny studio.',
        gallery: ['https://images.unsplash.com/photo-1502672260266-1c1e52d15461?auto=format&fit=crop&w=800&q=80'],
        amenities: ['WiFi', 'Air Conditioning'],
        bhk: 1,
        area: 500,
        furnishing: 'Furnished',
        floor: '5th',
        availability: 'Immediate',
        host: adminId
      },
      {
        name: 'Honda City',
        type: 'vehicle',
        category: 'Sedan',
        location: 'Downtown, City',
        price: 2500,
        description: 'Smooth ride for the city.',
        image: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=800&q=80',
        features: ['AC', 'Bluetooth'],
        fuel: 'Petrol',
        transmission: 'Automatic',
        seats: 5,
        badge: 'Top Rated',
        host: adminId
      }
    ]);

    console.log('Data Imported!');
    process.exit();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

seedData();

import mongoose from 'mongoose';

const listingSchema = new mongoose.Schema({
  title: { type: String }, // For properties
  name: { type: String },  // For vehicles
  type: { type: String, required: true }, // 'property' or 'vehicle'
  category: { type: String }, // Apartment, House, SUV, Bike
  location: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  image: { type: String }, // For vehicle
  gallery: [{ type: String }], // For property
  amenities: [{ type: String }], // For property
  features: [{ type: String }], // For vehicle
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Property specific
  bhk: { type: Number },
  area: { type: Number },
  furnishing: { type: String },
  floor: { type: String },
  availability: { type: String },
  status: { type: String, enum: ['available', 'rented'], default: 'available' },
  
  // Vehicle specific
  fuel: { type: String },
  transmission: { type: String },
  seats: { type: Number },
  badge: { type: String },
  bookingRevision: { type: Number, default: 0, select: false },
  
  rating: { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model('Listing', listingSchema);

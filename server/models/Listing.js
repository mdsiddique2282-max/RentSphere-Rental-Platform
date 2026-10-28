import mongoose from 'mongoose';
import { isCoordinates } from '../../src/data/coordinates.js';

const listingSchema = new mongoose.Schema({
  archivedAt: { type: Date },
  legacyId: { type: String, immutable: true },
  owner: { type: String },
  phone: { type: String },
  hostingDetailsVersion: { type: Number }, // Set only by a complete owner form save; no legacy default.
  brand: { type: String },
  available: { type: Boolean },
  interestUnavailable: { type: Boolean }, // Optional automatic hold; absent/false preserves manual restrictions.
  title: { type: String }, // For properties
  name: { type: String },  // For vehicles
  type: { type: String, required: true }, // 'property' or 'vehicle'
  category: { type: String }, // Apartment, House, SUV, Bike
  location: { type: String, required: true },
  locationCoordinates: { type: mongoose.Schema.Types.Mixed, validate: isCoordinates },
  price: { type: Number, required: true, min: 0, validate: Number.isFinite },
  description: { type: String },
  image: { type: String }, // For vehicle
  gallery: [{ type: String }], // For property
  amenities: [{ type: String }], // For property
  features: [{ type: String }], // For vehicle
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Optional catalog metadata: existing records receive no new defaults/values.
  catalogKey: { type: String, immutable: true },
  importBatch: { type: String, immutable: true },
  catalogDocumentHash: { type: String, immutable: true },
  inventoryKind: { type: String, enum: ['sample'] },
  sampleDisclosure: { type: String },
  publicationState: { type: String, enum: ['draft', 'published'] },
  previewOnly: { type: Boolean },
  mediaState: { type: String, enum: ['placeholder', 'reference-photos'] },
  ratePeriod: { type: String, enum: ['month', 'day'] },
  city: { type: String },
  areaName: { type: String },
  areaBasis: { type: String, enum: ['carpet'] },
  bathrooms: { type: Number },
  kind: { type: String, enum: ['Car', 'Bike'] },
  mediaCredits: { type: [{
    _id: false,
    url: String, sourcePage: String, author: String, license: String,
    licenseUrl: String, attribution: String, angle: String, sha256: String,
  }], default: undefined },
  
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

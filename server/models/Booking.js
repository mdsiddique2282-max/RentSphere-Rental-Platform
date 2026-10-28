import mongoose from 'mongoose';
import { isCoordinates } from '../../src/data/coordinates.js';
import { randomUUID } from 'node:crypto';

const bookingSchema = new mongoose.Schema({
  inventoryKind: { type: String, enum: ['sample'] },
  sampleDisclosure: { type: String },
  requestId: { type: String, default: randomUUID, immutable: true },
  requestType: { type: String, enum: ['vehicle', 'property_visit', 'property_booking'] },
  submissionKey: { type: String, immutable: true, select: false },
  propertyDecision: {
    type: new mongoose.Schema({ kind: { type: String, enum: ['interested', 'not-interested'] },
      recordedAt: Date, confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }, { _id: false }),
    default: undefined,
  },
  contact: {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'rejected'], default: 'pending' },
  hiddenFromCustomer: { type: Boolean }, // Optional: existing history stays visible; no migration/default write.
  hiddenFromAdmin: { type: Boolean, select: false }, // Admin-only archive; no default or changes to other history.
  adminHidden: { type: Boolean, select: false }, // Archived requests hidden only from Admin UI; never removed.
  hiddenFromOwners: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: undefined },
  ownerDecision: { type: new mongoose.Schema({
    status: { type: String, enum: ['confirmed', 'rejected', 'cancelled'] }, decidedAt: Date, dismissedAt: Date,
  }, { _id: false }), default: undefined },
  totalPrice: { type: Number, required: true },
  fulfilment: { type: String, enum: ['pickup', 'delivery'], default: 'pickup' },
  deliveryAddress: { type: String },
  deliveryCoordinates: { type: mongoose.Schema.Types.Mixed, validate: isCoordinates },
  deliveryQuote: { type: mongoose.Schema.Types.Mixed }, // Server-generated snapshot; absent for historical bookings.
  vehicleSnapshot: { type: new mongoose.Schema({
    name: String, pickupAddress: String,
    pickupCoordinates: { type: mongoose.Schema.Types.Mixed, validate: isCoordinates },
  }, { _id: false }), default: undefined },
  deliveryCharge: { type: Number, default: 0 },
}, { timestamps: true });

bookingSchema.index({ listing: 1, status: 1, startDate: 1, endDate: 1 });
// Partial indexes leave legacy records untouched. Cancelled/rejected requests
// release their key so a customer can submit a fresh request later.
bookingSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
bookingSchema.index({ submissionKey: 1 }, { unique: true, partialFilterExpression: {
  submissionKey: { $type: 'string' }, status: { $in: ['pending', 'confirmed'] },
} });

export default mongoose.model('Booking', bookingSchema);

import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'rejected'], default: 'pending' },
  totalPrice: { type: Number, required: true },
  fulfilment: { type: String, enum: ['pickup', 'delivery'], default: 'pickup' },
  deliveryAddress: { type: String },
  deliveryCharge: { type: Number, default: 0 },
}, { timestamps: true });

bookingSchema.index({ listing: 1, status: 1, startDate: 1, endDate: 1 });

export default mongoose.model('Booking', bookingSchema);

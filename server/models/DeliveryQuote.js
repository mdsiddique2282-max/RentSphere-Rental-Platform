import mongoose from 'mongoose';

// Short-lived server records bind reviewed quotes and retry eligibility to one request.
const schema = new mongoose.Schema({
  binding: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  listing: { type: mongoose.Schema.Types.ObjectId, required: true },
  attempts: { type: Number, default: 0 },
  state: { type: String, enum: ['new', 'temporary', 'no-route', 'calculated', 'estimated', 'unavailable'], default: 'new' },
  noRoute: { type: Boolean, default: false },
  busyUntil: Date,
  quote: mongoose.Schema.Types.Mixed,
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});
export default mongoose.model('DeliveryQuote', schema);

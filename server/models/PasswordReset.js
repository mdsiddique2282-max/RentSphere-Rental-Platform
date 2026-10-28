import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model('PasswordReset', schema);

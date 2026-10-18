import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const ownerProfileSchema = new mongoose.Schema({
  phone: { type: String, default: '' },
  businessName: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  bio: { type: String, default: '' },
  listingIntent: { type: String, default: '' }, // 'property' | 'vehicle' | 'both'
  idProofType: { type: String, default: '' },
  idProofNumber: { type: String, default: '' },
  documents: [{ type: String }],
  // Onboarding progress: 1 Registration, 2 Profile, 3 Submit information, 4 Review, 5 Admin decision
  currentStep: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'pending', 'approved', 'rejected'],
    default: 'not_started'
  },
  submittedAt: { type: Date },
  reviewedAt: { type: Date },
  reviewedBy: { type: String, default: '' },
  reviewNote: { type: String, default: '' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin', 'owner'], default: 'user' },
  ownerProfile: { type: ownerProfileSchema, default: () => ({}) },
}, { timestamps: true });

// Mongoose 9 async middleware uses returned promises; do not use callback-style next().
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model('User', userSchema);

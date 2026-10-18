import mongoose from 'mongoose';

// Separate private documents avoid the User document's 16 MB BSON limit and
// work on serverless hosts without relying on public or temporary disk storage.
const ownerDocumentSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contentType: { type: String, required: true },
  data: { type: Buffer, required: true, select: false }
}, { timestamps: true });

export default mongoose.model('OwnerDocument', ownerDocumentSchema);

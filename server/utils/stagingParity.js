import mongoose from 'mongoose';
import Listing from '../models/Listing.js';
import { previewPropertyWorkflow } from './previewPropertyWorkflow.js';

// Presentation projections, never database writes. Keep original stored fields
// and existing routes while making the Atlas-backed catalog authoritative.
export async function stagingListingPresentation(req, res, next) {
  const json = res.json;
  const mark = row => {
    const plain = typeof row?.toObject === 'function' ? row.toObject() : row;
    if (!plain?._id || !['property', 'vehicle'].includes(plain.type)) return plain;
    return { ...plain, catalogContext: 'staging',
      ...(req.path !== '/mine' && plain.type === 'property' && !plain.inventoryKind && !plain.hostingDetailsVersion && plain.image ? { gallery: [plain.image] } : {}) };
  };
  res.json = function(data) { return json.call(this, Array.isArray(data) ? data.map(mark) : mark(data)); };
  try {
    if (req.method === 'GET' && /^\/(RS|V)\d+$/.test(req.path)) {
      const listing = await Listing.findOne({ legacyId: req.path.slice(1), archivedAt: { $exists: false } }).select('_id');
      if (listing) req.url = '/' + listing._id;
    }
    next();
  } catch { res.status(503).json({ message: 'Listing is temporarily unavailable.' }); }
}

let currentClient, workflow;
export function stagingInterestWorkflow(req, res, next) {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Staging is temporarily unavailable.' });
  const client = mongoose.connection.getClient();
  if (client !== currentClient) {
    currentClient = client;
    workflow = previewPropertyWorkflow({ client, targetDatabase: mongoose.connection.name, autoRentOnInterest: false, save: async () => {} });
  }
  return workflow(req, res, next);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import OwnerDocument from '../models/OwnerDocument.js';

const uploadsDir = fileURLToPath(new URL('../uploads/', import.meta.url));
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const safeType = type => /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp|avif))$/.test(type) ? type : 'application/octet-stream';

export async function storeOwnerDocuments(files, ownerId) {
  const documents = [];
  for (const file of files || []) {
    const document = await OwnerDocument.create({ owner: ownerId, contentType: file.mimetype, data: file.buffer });
    documents.push(`owner-document:${document._id}`);
  }
  return documents;
}

// Legacy identity files remain on disk, but are never served through /uploads.
// Only files explicitly referenced by a listing are public. Fail closed if the
// database cannot establish that a file is public. No existing records are moved.
export async function servePublicListingUpload(req, res) {
  res.set('Cache-Control', 'no-store');
  let filename;
  try { filename = decodeURIComponent(req.path).slice(1); } catch { return res.sendStatus(404); }
  if (!safeName.test(filename)) return res.sendStatus(404);
  const url = `/uploads/${filename}`;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const privateFile = await User.exists({ 'ownerProfile.documents': { $regex: `^${escaped}$`, $options: 'i' } }).maxTimeMS(5000);
    if (privateFile) return res.sendStatus(404);
    const publicFile = await Listing.exists({ $or: [{ image: url }, { gallery: url }] }).maxTimeMS(5000);
    if (!publicFile) return res.sendStatus(404);
    return res.sendFile(filename, { root: uploadsDir, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.sendStatus(error.statusCode === 404 ? 404 : 500);
    });
  } catch {
    return res.status(503).json({ message: 'Uploads are temporarily unavailable.' });
  }
}

export async function serveOwnerDocument(req, res) {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  const { ownerId, index } = req.params;
  if (!/^[a-fA-F0-9]{24}$/.test(ownerId) || !/^(0|[1-9]\d*)$/.test(index)) return res.sendStatus(404);
  if (req.user.role !== 'admin' && String(req.user._id) !== ownerId) return res.sendStatus(403);
  try {
    const owner = await User.findById(ownerId).select('ownerProfile.documents');
    const reference = owner?.ownerProfile?.documents?.[Number(index)];
    if (!reference) return res.sendStatus(404);
    if (reference.startsWith('owner-document:')) {
      const document = await OwnerDocument.findOne({ _id: reference.slice('owner-document:'.length), owner: ownerId }).select('+data');
      if (!document) return res.sendStatus(404);
      return res.type(safeType(document.contentType)).send(document.data);
    }
    // Compatibility for documents previously embedded in MongoDB on Vercel.
    const embedded = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(reference);
    if (embedded) return res.type(safeType(embedded[1])).send(Buffer.from(embedded[2], 'base64'));
    if (!reference.startsWith('/uploads/')) return res.sendStatus(404);
    const filename = reference.slice('/uploads/'.length);
    if (!safeName.test(filename)) return res.sendStatus(404);
    const types = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
    res.type(types[path.extname(filename).toLowerCase()] || 'application/octet-stream');
    return res.sendFile(filename, { root: uploadsDir, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.sendStatus(error.statusCode === 404 ? 404 : 500);
    });
  } catch {
    return res.status(503).json({ message: 'Document is temporarily unavailable.' });
  }
}

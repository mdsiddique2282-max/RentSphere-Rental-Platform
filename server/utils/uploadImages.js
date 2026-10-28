import fs from 'fs';
import path from 'path';
import { existingUpload, uploadDirectory } from './uploadPaths.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import Listing from '../models/Listing.js';
import User from '../models/User.js';

const imageTypes = { jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'], gif: ['image/gif', 'gif'], tiff: ['image/tiff', 'tiff'] };
const invalidImage = () => Object.assign(new Error('Choose a valid JPEG, PNG, WebP, GIF, TIFF or AVIF image.'), { status: 400 });

// Absolute URLs, query strings and encoded filenames can refer to the same
// upload. Compare the actual upload path, not just the stored URL spelling.
export function listingUploadPath(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, 'https://uploads.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const pathname = decodeURIComponent(url.pathname);
    return /^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pathname) ? pathname : null;
  } catch { return null; }
}

export async function listingImageUsers(image, session = null) {
  const upload = listingUploadPath(image);
  if (!upload) return [];
  const rows = await Listing.find({ $or: [{ image: { $exists: true } }, { gallery: { $exists: true } }] }).select('image gallery host').session(session).maxTimeMS(5000).lean();
  return rows.filter(row => [row.image, ...(row.gallery || [])].some(value => listingUploadPath(value)?.toLowerCase() === upload.toLowerCase()));
}

export async function validateListingImage(buffer, claimedType) {
  try {
    const decoder = sharp(buffer, { failOn: 'warning', limitInputPixels: 64 * 1024 * 1024 });
    const metadata = await decoder.metadata();
    const type = metadata.format === 'heif' && metadata.compression === 'av1' ? ['image/avif', 'avif'] : imageTypes[metadata.format];
    if (!type || (claimedType && claimedType !== type[0] && !(type[0] === 'image/jpeg' && claimedType === 'image/jpg'))) throw invalidImage();
    await decoder.stats(); // Decode pixels too: magic bytes alone do not establish a valid image.
    return { contentType: type[0], extension: type[1] };
  } catch { throw invalidImage(); }
}

export async function saveListingImages(files, directory = uploadDirectory) {
  const types = [];
  for (const file of files || []) types.push(await validateListingImage(file.buffer, file.mimetype));
  if (!isServerless() && files?.length) await fs.promises.mkdir(directory, { recursive: true });
  for (const [index, file] of (files || []).entries()) {
    file.mimetype = types[index].contentType;
    if (!isServerless()) {
      const filename = `${randomUUID()}.${types[index].extension}`;
      await fs.promises.writeFile(path.join(directory, filename), file.buffer, { flag: 'wx' });
      file.filename = filename;
    }
  }
}

// New local references must come from an authorized listing. Lock that source in
// the same transaction as the destination save, serializing reuse with deletion.
export async function assertListingImageReferences(images, actor, { listing, uploaded = [], session } = {}) {
  const retained = new Set([listing?.image, ...(listing?.gallery || []), ...uploaded].filter(Boolean));
  for (const image of new Set(images.filter(Boolean))) {
    if (retained.has(image)) continue;
    if (image.startsWith('data:')) {
      const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
      if (!match) throw invalidImage();
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) throw invalidImage();
      await validateListingImage(buffer, match[1]);
    } else if (listingUploadPath(image)) {
      const escaped = listingUploadPath(image).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (await User.exists({ 'ownerProfile.documents': { $regex: `^${escaped}$`, $options: 'i' } }).session(session)) throw Object.assign(new Error('This image cannot be reused.'), { status: 403 });
      const authorized = (await listingImageUsers(image, session)).find(row => actor.role === 'admin' || String(row.host) === String(actor._id));
      if (!authorized) throw Object.assign(new Error('Only images from your own listings can be reused.'), { status: 403 });
      const source = await Listing.findOneAndUpdate({ _id: authorized._id },
        { $inc: { bookingRevision: 1 } }, { session, returnDocument: 'after', timestamps: false });
      if (!source) throw Object.assign(new Error('Only images from your own listings can be reused.'), { status: 403 });
    }
  }
}

export const isServerless = () => process.env.VERCEL === '1';

export function mapUploadedFiles(files) {
  if (!files?.length) return [];

  if (isServerless()) {
    return files.map((file) => {
      const base64 = file.buffer.toString('base64');
      return `data:${file.mimetype};base64,${base64}`;
    });
  }

  return files.map((file) => `/uploads/${file.filename}`);
}

export async function deleteListingFiles(listing, { findUpload = existingUpload } = {}) {
  if (isServerless()) return;

  const images = [...new Set([listing.image, ...(listing.gallery || [])].map(listingUploadPath).filter(Boolean))];

  for (const img of images) {
    try {
      // Include archived listings and legacy private documents. On DB errors,
      // leave the file intact rather than risk deleting somebody else's media.
      const escaped = img.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if ((await listingImageUsers(img)).length ||
          await User.exists({ 'ownerProfile.documents': { $regex: `^${escaped}$`, $options: 'i' } })) continue;
      const filename = img.replace('/uploads/', '');
      const filePath = findUpload(filename)?.path;
      if (!filePath) continue;
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          console.error('Unreferenced image cleanup failed; file retained.');
        }
      }
    } catch { console.error('Image cleanup could not be verified; file retained.'); }
  }
}

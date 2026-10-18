import fs from 'fs';
import path from 'path';

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

export function deleteListingFiles(listing) {
  if (isServerless()) return;

  const images = [];
  if (listing.image && listing.image.startsWith('/uploads/')) images.push(listing.image);
  if (Array.isArray(listing.gallery)) {
    listing.gallery.forEach((img) => {
      if (img && img.startsWith('/uploads/') && !images.includes(img)) images.push(img);
    });
  }

  images.forEach((img) => {
    const filename = img.replace('/uploads/', '');
    const filePath = path.join('uploads', filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error('Failed deleting file:', err);
      }
    }
  });
}

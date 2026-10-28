import { ownerListingTypes } from '../../src/data/ownerPolicy.js';
import { coordinateValue } from '../../src/data/coordinates.js';
const failure = (status, message) => Object.assign(new Error(message), { status });

export function assertPublisher(actor) {
  if (actor.role !== 'admin' && !(actor.role === 'owner' && actor.ownerProfile?.status === 'approved')) {
    throw failure(403, 'Admin approval as an owner is required to publish or manage listings.');
  }
}

export function assertHostingType(actor, type) {
  assertPublisher(actor);
  if (actor.role !== 'admin' && !ownerListingTypes(actor.ownerProfile).includes(type)) throw failure(403, ownerListingTypes(actor.ownerProfile).length ? 'Your approved owner category does not allow this listing type.' : 'Your approved hosting category is missing or unsupported. Please contact the administrator.');
}

export function assertListingManager(actor, listing) {
  assertPublisher(actor);
  if (actor.role !== 'admin' && String(listing.host?._id || listing.host) !== String(actor._id)) {
    throw failure(403, 'Only the listing host or an admin can manage this listing.');
  }
}

const textFields = new Set([
  'title', 'name', 'category', 'location', 'description', 'image',
  'furnishing', 'floor', 'availability', 'fuel', 'transmission', 'badge', 'phone', 'kind'
]);
const numberFields = new Set(['price', 'bhk', 'area', 'seats']);
const arrayFields = new Set(['gallery', 'amenities', 'features']);

// Never pass request bodies directly into a document or update operator. In
// particular, host, type, IDs, verification fields and bookingRevision are fixed.
export function listingUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
    throw failure(400, 'Provide at least one editable listing field.');
  }
  const update = {};
  for (const [key, value] of Object.entries(body)) {
    if (textFields.has(key)) {
      if (typeof value !== 'string' || (key === 'location' && !value.trim())) {
        throw failure(400, `Invalid ${key}.`);
      }
    } else if (numberFields.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw failure(400, `Invalid ${key}.`);
      }
    } else if (arrayFields.has(key)) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw failure(400, `Invalid ${key}.`);
      }
    } else if (key === 'locationCoordinates') {
      coordinateValue(value, true);
    } else if (key === 'status') {
      if (!['available', 'rented'].includes(value)) throw failure(400, 'Invalid listing status.');
    } else {
      throw failure(400, `Field '${key}' cannot be updated.`);
    }
    if (key === 'image' || key === 'gallery') {
      const images = Array.isArray(value) ? value : [value];
      if (images.some(url => url.startsWith('/uploads/') && !/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url))) {
        throw failure(400, 'Invalid upload reference.');
      }
    }
    update[key] = value;
  }
  return update;
}

// Shared policy for vehicle confirmations, property visits and cancellation.
export function assertRequestTransition({ kind, from, to, actor, customerId, hostId }) {
  if (!['vehicle', 'property_visit'].includes(kind)) throw failure(400, 'Unknown request type.');
  if (to === 'cancelled') {
    if (String(actor._id) !== String(customerId)) throw failure(403, 'Only the customer can cancel this request.');
  } else if (['confirmed', 'rejected'].includes(to)) {
    assertPublisher(actor);
    if (actor.role !== 'admin' && String(actor._id) !== String(hostId)) {
      throw failure(403, 'Only the listing host or an admin can decide this request.');
    }
  } else {
    throw failure(409, 'Invalid request status transition.');
  }
  // Existing confirmation retries remain idempotent. Other duplicate/terminal
  // transitions are conflicts; rejected and cancelled requests cannot be revived.
  if (from === 'confirmed' && to === 'confirmed') return;
  if ((from === 'pending' && ['confirmed', 'rejected', 'cancelled'].includes(to)) ||
      (from === 'confirmed' && to === 'cancelled')) return;
  throw failure(409, `Cannot change a ${from} request to ${to}.`);
}

// In-memory fallback store for the Owner Onboarding flow.
// Mirrors the resilient "works even when MongoDB is unreachable" pattern
// already used across this project (see inMemoryListings in listings.js).
// Keyed by email so a dummy-token / offline session still behaves consistently.

const applications = new Map();

export function getOwnerApp(email) {
  if (!email) return null;
  return applications.get(email.toLowerCase()) || null;
}

export function upsertOwnerApp(email, data) {
  if (!email) return null;
  const key = email.toLowerCase();
  const existing = applications.get(key) || {
    email: key,
    name: '',
    documents: [],
    currentStep: 1,
    status: 'not_started'
  };
  const merged = { ...existing, ...data, email: key };
  applications.set(key, merged);
  return merged;
}

export function listOwnerApps() {
  return Array.from(applications.values());
}

export function deleteOwnerApp(email) {
  if (!email) return;
  applications.delete(email.toLowerCase());
}

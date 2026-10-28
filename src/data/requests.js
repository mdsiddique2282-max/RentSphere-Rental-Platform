import { isSampleRequest } from './whatsappRecipient.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isCoordinates } from './coordinates.js';

export const requestReturnPath = value => typeof value === 'string' && /^\/request\/[a-f\d]{24}$/i.test(value) ? value : '';

export function appendRequestLink(message, request, origin = globalThis.location?.origin) {
  const path = requestReturnPath(`/request/${request?._id}`);
  if (!path || !origin) return message;
  const base = new URL(origin);
  return ['http:', 'https:'].includes(base.protocol) ? `${message}\nRequest Link: ${base.origin}${path}` : message;
}

export async function resolveRequestLink({ id, account, token, send = fetch }) {
  if (!requestReturnPath(`/request/${id}`)) throw new Error('This request is unavailable or you do not have access.');
  const read = async path => {
    const response = await send(path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    let rows;
    try { rows = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null; } catch {}
    if (!response.ok || !Array.isArray(rows)) throw new Error('Unable to open this request. Please try again.');
    return rows.find(row => row._id?.toLowerCase() === id.toLowerCase());
  };
  let row = await read('/api/bookings/mybookings'), view = 'customer';
  if (!row && account?.role === 'owner' && account.ownerProfile?.status === 'approved') {
    row = await read('/api/bookings/owner/requests'); view = 'owner';
  }
  if (!row) throw new Error('This request is unavailable or you do not have access.');
  const type = row.requestType === 'property_visit' || row.listing?.type === 'property' ? 'property' : 'vehicle';
  return `${view === 'owner' ? '/owner-dashboard' : '/dashboard'}?request=${row._id}&view=${view}&type=${type}`;
}

// Only highlight rows already returned by the existing authorized dashboard API.
export function useLinkedRequest({ search, view, rows, loading, error, token, setType, setGroup }) {
  const params = new URLSearchParams(search), id = params.get('request');
  const active = params.get('view') === view && /^[a-f\d]{24}$/i.test(id || '');
  const linkedRow = active ? rows.find(row => row._id?.toLowerCase() === id.toLowerCase()) : null;
  const focused = useRef('');
  useEffect(() => {
    focused.current = '';
    if (active) { setType(params.get('type') === 'property' ? 'property' : 'vehicle'); setGroup?.('All'); }
  }, [search, token]);
  useEffect(() => {
    if (!active || loading || error || !linkedRow || focused.current === `${token}:${search}`) return;
    const card = document.getElementById(`request-${view}-${linkedRow._id}`);
    if (card) { card.scrollIntoView({ block: 'center' }); card.focus({ preventScroll: true }); focused.current = `${token}:${search}`; }
  });
  return { linkedRow, unavailable: params.get('view') === view && !loading && !error && !linkedRow };
}

const draftLifetime = 30 * 60000;
const draftStorage = () => { try { return globalThis.sessionStorage; } catch { return null; } };
const draftKey = (user, item, kind) => user?._id && ['vehicle', 'property_visit'].includes(kind)
  ? `rentsphere-request:${encodeURIComponent(user._id)}:${kind}:${encodeURIComponent(item?._id || item?.id || '')}` : null;
const draftForm = (form, kind) => {
  if (!form || typeof form !== 'object') return null;
  const limits = { name: 254, email: 254, phone: 254, start: 10, ...(kind === 'vehicle' ? { end: 10, fulfilment: 8, address: 500 } : {}) };
  const clean = {};
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof form[key] !== 'string' || form[key].length > limit) return null;
    clean[key] = form[key];
  }
  if (kind === 'vehicle' && !['pickup', 'delivery'].includes(clean.fulfilment)) return null;
  for (const value of [clean.start, clean.end].filter(Boolean)) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z');
    if (!date || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value || value < requestToday()) return null;
  }
  if (clean.end && (!clean.start || clean.end < clean.start)) return null;
  return clean;
};

export function clearRequestDraft(user, item, kind, storage = draftStorage()) {
  try { const key = draftKey(user, item, kind); if (key) storage?.removeItem(key); } catch { /* Storage may be disabled by the browser. */ }
}

export function readRequestDraft(user, item, kind, storage = draftStorage(), now = Date.now()) {
  try {
    const key = draftKey(user, item, kind); if (!key) return null;
    const record = JSON.parse(storage?.getItem(key) || 'null');
    if (!record) return null;
    if (record.version !== 1 || !Number.isFinite(record.expiresAt) || record.expiresAt <= now || record.expiresAt > now + draftLifetime ||
        !['draft', 'submitted'].includes(record.state)) throw new Error('Expired or invalid draft');
    // A receipt restores only the existing success panel, never an editable form.
    if (record.state === 'submitted') return { submitted: true };
    const form = draftForm(record.form, kind);
    if (!form || (record.coordinates !== null && !isCoordinates(record.coordinates))) throw new Error('Invalid draft');
    return { form, coordinates: record.coordinates };
  } catch { clearRequestDraft(user, item, kind, storage); return null; }
}

export function writeRequestDraft(user, item, kind, value, storage = draftStorage(), now = Date.now()) {
  try {
    const key = draftKey(user, item, kind); if (!key) return;
    const form = value.submitted ? null : draftForm(value.form, kind);
    if (!value.submitted && (!form || (value.coordinates != null && !isCoordinates(value.coordinates)))) { clearRequestDraft(user, item, kind, storage); return; }
    storage?.setItem(key, JSON.stringify({ version: 1, expiresAt: now + draftLifetime,
      ...(value.submitted ? { state: 'submitted' } : { state: 'draft', form, coordinates: value.coordinates || null }) }));
  } catch { /* In-memory booking still works when session storage is unavailable. */ }
}

export function useRequestDraft({ user, item, kind, initialForm, onClose }) {
  const [restored] = useState(() => readRequestDraft(user, item, kind));
  const [form, setForm] = useState(() => restored?.form || initialForm);
  const [coordinates, setCoordinates] = useState(() => restored?.coordinates || null);
  const [done, updateDone] = useState(Boolean(restored?.submitted));
  const finished = useRef(done), closed = useRef(false), latest = useRef();
  latest.current = { form, coordinates };
  const scope = draftKey(user, item, kind);
  useEffect(() => {
    const persist = () => { if (!finished.current && !closed.current) writeRequestDraft(user, item, kind, latest.current); };
    persist();
    const hide = () => { if (document.visibilityState === 'hidden') persist(); };
    window.addEventListener('pagehide', persist); document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('pagehide', persist); document.removeEventListener('visibilitychange', hide); };
  }, [scope, form, coordinates]);
  const setDone = value => {
    if (value) { finished.current = true; if (!closed.current) writeRequestDraft(user, item, kind, { submitted: true }); }
    updateDone(value);
  };
  const close = useCallback(() => {
    closed.current = true; clearRequestDraft(user, item, kind); onClose();
  }, [scope, onClose]);
  return { form, setForm, coordinates, setCoordinates, done, setDone, close };
}

export function previewVisitMessage(item, form) {
  return `RentSphere — Property Visit Request${isSampleRequest(item) ? ' (Demo)' : ''}\n\nProperty: ${item.title || item.name}\nLocation: ${item.location}\n\nCustomer Details:\nName: ${form.name}\nPhone: ${form.phone}\nEmail: ${form.email}\n\nPreferred Visit Date: ${form.start}\n\nMessage from Customer:\n\nHello, I am interested in visiting this property.\n\nPlease confirm my visit request and share the exact property location (preferably a Google Maps link) and a suitable visiting time, so I can visit the property conveniently.\n\nThank you!\n\nNote for Property Owner:\nPlease log in to your RentSphere Owner Dashboard to Accept or Reject this visit request.\n\nOnce accepted, kindly coordinate with the customer to confirm the exact property location and visiting time.`;
}

export function requestToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function validateRequest({ user, listingId, startDate, endDate }) {
  if (!user?.token) throw new Error('Please log in to submit your request.');
  if (!/^[0-9a-fA-F]{24}$/.test(String(listingId || ''))) {
    throw new Error('This demo listing cannot accept saved requests. Please choose a database listing.');
  }
  for (const value of [startDate, endDate]) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T00:00:00.000Z`) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('Choose valid request dates.');
    }
  }
  if (startDate < requestToday()) throw new Error('Choose today or a future date.');
  if (endDate < startDate) throw new Error('Return date cannot be before the pickup date.');
}

export async function saveRequest({ user, isVisit = false, ...body }) {
  validateRequest({ user, ...body, endDate: isVisit ? body.startDate : body.endDate });
  const response = await fetch(isVisit ? '/api/bookings/visits' : '/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Unable to save your request. Please try again.');
  return data;
}

// Reserve the WhatsApp tab during the user gesture: opening it only after an
// asynchronous save can be blocked by browsers. Never send a message automatically.
export function reserveWhatsapp() {
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  return popup;
}

export function showWhatsapp(popup, url) {
  if (popup && !popup.closed) popup.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
}

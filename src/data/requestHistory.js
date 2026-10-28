import { requestToday } from './requests.js';

export function historyGroup(request, today = requestToday()) {
  if (['cancelled', 'rejected'].includes(request.status)) return 'Rejected / cancelled';
  if (request.status === 'completed' || (request.endDate || request.startDate || '').slice(0, 10) < today) return 'Past / completed';
  return request.status === 'pending' ? 'Pending requests' : 'Upcoming / active';
}
export function requestStatus(request, today = requestToday()) {
  if (request.status === 'confirmed' && (request.endDate || request.startDate || '').slice(0, 10) < today)
    return request.requestType === 'property_visit' ? 'Past visit' : 'Completed';
  return ({ pending: 'Pending', confirmed: 'Confirmed / Accepted', rejected: 'Rejected', cancelled: 'Cancelled', completed: 'Completed' })[request.status] || request.status;
}
// Hide a card only after the server confirms customer-specific visibility.
export async function removeHistoryRequest({ id, token, fetcher = fetch, onRemoved }) {
  let response, data;
  try {
    response = await fetcher(`/api/bookings/${encodeURIComponent(id)}/hide`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
    data = await response.json();
  } catch { throw new Error('Unable to remove request from history. Please try again.'); }
  if (!response.ok) throw new Error(data.message || 'Unable to remove request from history. Please try again.');
  if (data.hiddenFromCustomer !== true || String(data._id) !== String(id)) throw new Error('Unable to confirm history removal. Please refresh and try again.');
  onRemoved(id);
}


export async function hideDashboardRequests({ ids, direction, kind, token, send = fetch }) {
  const response = await send('/api/bookings/hide-all', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ ids, direction, kind }) });
  let data;
  try { data = await response.json(); } catch { throw new Error('Unable to remove requests. Refresh and retry safely.'); }
  if (!response.ok || !Array.isArray(data.hiddenIds) || data.hiddenIds.length !== ids.length || new Set(data.hiddenIds).size !== ids.length || data.hiddenIds.some(id => !ids.includes(id))) throw new Error(data.message || 'Unable to confirm removal. Refresh and retry safely.');
  return data.hiddenIds;
}

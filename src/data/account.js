// Only pass backend-verified account data here; cached session labels are not approval.
export const dashboardKind = account => account?.role === 'admin' ? 'admin'
  : account?.role === 'owner' && account.ownerProfile?.status === 'approved' ? 'owner' : 'user';

export async function fetchCurrentAccount(token, fetcher = fetch) {
  const unavailable = 'Account verification is temporarily unavailable. Please try again.';
  let response, data;
  try {
    response = await fetcher('/api/auth/me', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    // A stale backend/proxy may return an HTML 404/502. Never display that body
    // or treat an HTML 401 as evidence that the actual JWT has been revoked.
    if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) throw new Error(unavailable);
    data = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(unavailable);
  } catch { throw new Error(unavailable); }
  if (!response.ok) throw Object.assign(new Error(data.message || 'Unable to verify your account.'), { status: response.status });
  if (!data._id || !['user', 'owner', 'admin'].includes(data.role)) throw new Error('Unable to verify your account.');
  return data;
}

export function accountRefreshFailure(previous, token, message) {
  return { status: 'error', account: previous.token === token ? previous.account : null, token, error: message };
}

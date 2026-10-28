// Reserve a tab during the click; never place JWTs in URLs or expose storage references.
export async function openPrivateOwnerDocument({ ownerId, index, token, isCurrent = () => true, send = fetch,
  open = (...args) => window.open(...args), createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url),
  later = setTimeout, repeat = setInterval, stop = clearInterval }) {
  const tab = open('', '_blank');
  if (!tab) throw new Error('Please allow popups to view verification documents.');
  tab.opener = null;
  let url, timer, cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; if (url) revokeUrl(url); if (timer) stop(timer); };
  try {
    const response = await send(`/api/owner/documents/${encodeURIComponent(ownerId)}/${index}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'This verification document is missing.' : 'Unable to open this verification document. Please sign in as an administrator and retry.');
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!/^(application\/pdf|image\/(png|jpeg|gif|webp|bmp|avif))$/.test(type || '')) throw new Error('This document format cannot be previewed safely.');
    const blob = await response.blob();
    if (!blob.size) throw new Error('This verification document is empty.');
    if (!isCurrent() || tab.closed) throw new Error('Document review was cancelled.');
    url = createUrl(blob); tab.location.replace(url);
    timer = repeat(() => { if (tab.closed) cleanup(); }, 1000);
    later(cleanup, 60000);
    return cleanup;
  } catch (error) { cleanup(); tab.close(); throw error; }
}

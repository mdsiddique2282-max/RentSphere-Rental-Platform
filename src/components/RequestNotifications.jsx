import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { requestNotification } from '../data/requestNotifications';
import './RequestNotifications.css';

async function readUpdateResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Request updates are temporarily unavailable. Please retry.'); }
  if (!response.ok) throw new Error(data.message || 'Unable to complete the request update. Please retry.');
  return data;
}

export function RequestNotificationCard({ row, busy, onDismiss }) {
  const notice = requestNotification(row);
  return <article className={`request-notification ${notice.accepted ? 'is-accepted' : 'is-rejected'}`}>
    <div><h3>{notice.title}</h3><p>{notice.description}</p>
      {notice.contactUrl && <a className="text-link" href={notice.contactUrl} target="_blank" rel="noreferrer">Contact Owner on WhatsApp →</a>}
      {notice.contactError && <p className="notification-contact-error">{notice.contactError}</p>}
    </div><button className="history-remove" disabled={busy} onClick={() => onDismiss(row)} aria-label="Dismiss request notification">Dismiss</button>
  </article>;
}

export default function RequestNotifications() {
  const { user } = useContext(AuthContext);
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const tokenRef = useRef(user?.token); tokenRef.current = user?.token;
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const token = user?.token; const id = ++sequence.current;
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/bookings/notifications', { headers: { Authorization: `Bearer ${token}` } });
      const data = await readUpdateResponse(response);
      if (tokenRef.current === token && id === sequence.current) setRows(data);
    } catch (error) { if (tokenRef.current === token && id === sequence.current) setError(error.message || 'Unable to load request updates. Please retry.'); }
    finally { if (tokenRef.current === token && id === sequence.current) setLoading(false); }
  }, [user?.token]);
  useEffect(() => { setRows([]); if (user?.token) load(); return () => { ++sequence.current; }; }, [user?.token, load]);
  const dismiss = async row => {
    const token = user.token; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/bookings/${row._id}/dismiss-notification`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
      await readUpdateResponse(response);
      if (tokenRef.current === token) { ++sequence.current; setLoading(false); setRows(previous => previous.filter(value => value._id !== row._id)); }
    } catch (error) { if (tokenRef.current === token) setError(error.message || 'Unable to dismiss update. Please retry.'); }
    finally { setBusy(false); }
  };
  return <section className="request-notifications" aria-label="Your request updates"><header><h2>Your Request Updates</h2><button className="text-link" disabled={busy || loading} onClick={load}>Refresh</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading ? <p className="notification-empty">Loading request updates…</p> : rows.length ? rows.map(row => <RequestNotificationCard key={row._id} row={row} busy={busy} onDismiss={dismiss} />) : <p className="notification-empty">No new request decisions.</p>}
  </section>;
}

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { hideDashboardRequests, requestStatus } from '../data/requestHistory';
import VehicleBookingFacts from './VehicleBookingFacts';
import HistoryConfirmation from './HistoryConfirmation';
import { useLocation } from 'react-router-dom';
import { useLinkedRequest } from '../data/requests';

export function OwnerRequestCard({ row, busy, decide, onRemove, highlighted = false }) {
  const vehicle = row.requestType === 'vehicle' || row.listing?.type === 'vehicle';
  const propertyVisit = row.requestType === 'property_visit' || (!row.requestType && row.listing?.type === 'property');
  const submitted = typeof row.createdAt === 'string' && row.createdAt.trim() ? new Date(row.createdAt) : null;
  const validSubmitted = submitted && Number.isFinite(submitted.getTime());
  return <article className="owner-request-card" id={`request-owner-${row._id}`} tabIndex={-1} style={highlighted ? { outline: '2px solid var(--blue)', outlineOffset: '3px' } : undefined}>
    <div className="owner-request-card-head"><h3>{(vehicle && row.vehicleSnapshot?.name) || row.listing?.title || row.listing?.name || 'Historical listing'}</h3><span className="status">{requestStatus(row)}</span></div>
    <dl className="owner-request-details"><dt>Customer</dt><dd>{row.contact?.name || row.user?.name}</dd><dt>Contact</dt><dd>{row.contact?.email || row.user?.email}{row.contact?.phone && <><br />{row.contact.phone}</>}</dd><dt>{vehicle ? 'Rental dates' : 'Visit date'}</dt><dd>{row.startDate?.slice(0, 10)}{vehicle && ` – ${row.endDate?.slice(0, 10)}`}</dd>
      {propertyVisit && <><dt>Property Location</dt><dd>{typeof row.listing?.location === 'string' && row.listing.location.trim() || 'Not available'}</dd><dt>Requested On</dt><dd>{validSubmitted ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(submitted) : 'Not available'}</dd><dt>Requested At</dt><dd>{validSubmitted ? new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(submitted) : 'Not available'}</dd></>}
      {vehicle && <><dt>Fulfilment</dt><dd>{row.fulfilment === 'delivery' ? 'Home delivery' : 'Self pickup'}</dd><VehicleBookingFacts row={row} /></>}
    </dl>
    {row.propertyDecision && <p className="owner-request-interest">Customer interest: {row.propertyDecision.kind}. This does not finalize a rental.</p>}
    {row.status === 'pending' && <div className="decision-actions"><button className="btn btn-primary" disabled={busy} onClick={() => decide(row, 'confirm')}>Accept</button><button className="save-button" disabled={busy} onClick={() => decide(row, 'reject')}>Reject</button></div>}
    {['confirmed', 'rejected', 'cancelled'].includes(row.status) && <div className="decision-actions"><button className="history-remove" disabled={busy} onClick={() => onRemove(row)} aria-label="Remove request from owner history"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg><span>Remove</span></button></div>}
  </article>;
}

export default function OwnerRequests() {
  const { user } = useContext(AuthContext);
  const location = useLocation();
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [type, setType] = useState('all');
  const [bulk, setBulk] = useState(null);
  const bulkLock = useRef(null);
  const [remove, setRemove] = useState(null), [removeError, setRemoveError] = useState('');
  const tokenRef = useRef(user?.token); tokenRef.current = user?.token;
  const requestSequence = useRef(0);
  const closeRemove = useCallback(() => { setRemove(null); setBulk(null); setRemoveError(''); }, []);
  const load = async ({ background = false } = {}) => {
    const token = user?.token, current = ++requestSequence.current;
    if (!background) setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/bookings/owner/requests', { headers: { Authorization: `Bearer ${user.token}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      if (tokenRef.current === token && current === requestSequence.current) setRows(data);
    } catch (e) { if (tokenRef.current === token && current === requestSequence.current) setError(e.message || 'Unable to load customer requests.'); }
    finally { if (tokenRef.current === token && current === requestSequence.current) setLoading(false); }
  };
  useEffect(() => {
    setRows([]); setBusy(false); closeRemove(); load();
    const refresh = () => load({ background: true });
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => { ++requestSequence.current; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [user?.token, closeRemove]);
  const decide = async (row, action) => {
    const token = user.token;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/bookings/${row._id}/${action}`, { method: 'PUT', headers: { Authorization: `Bearer ${user.token}` } });
      const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.message), { status: response.status });
      if (tokenRef.current === token) await load();
    } catch (e) {
      if (tokenRef.current === token) { if (e.status === 409) await load({ background: true }); if (tokenRef.current === token) setError(e.message || 'Unable to record your decision.'); }
    }
    finally { if (tokenRef.current === token) setBusy(false); }
  };
  const shown = rows.filter(row => type === 'all' || row.listing?.type === type);
  const { linkedRow, unavailable } = useLinkedRequest({ search: location.search, view: 'owner', rows, loading, error, token: user?.token, setType });
  const hideAll = async () => {
    if (busy || !bulk || bulk.token !== user.token || bulkLock.current === user.token) return;
    const token = user.token; bulkLock.current = token;
    setBusy(true); setRemoveError('');
    try {
      const ids = await hideDashboardRequests({ ...bulk, direction: 'owner', token });
      if (tokenRef.current !== token) return;
      ++requestSequence.current; setRows(previous => previous.filter(row => !ids.includes(row._id))); closeRemove(); await load();
    } catch (error) { if (tokenRef.current === token) setRemoveError(error.message); }
    finally { if (bulkLock.current === token) bulkLock.current = null; if (tokenRef.current === token) setBusy(false); }
  };
  const hideRequest = async () => {
    if (!remove || busy) return;
    const token = user.token;
    setBusy(true); setRemoveError('');
    try {
      const response = await fetch(`/api/bookings/${remove._id}/hide-owner`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      if (tokenRef.current !== token) return;
      ++requestSequence.current;
      setRows(previous => previous.filter(row => row._id !== remove._id)); closeRemove();
    } catch (error) { if (tokenRef.current === token) setRemoveError(error.message || 'Unable to remove this request. Please retry.'); }
    finally { setBusy(false); }
  };
  return <section className="info-card owner-request-section"><div className="owner-request-heading"><div><h2 tabIndex={-1}>Customer Requests</h2><p>{rows.filter(row => row.status === 'pending').length} pending · {rows.filter(row => row.status === 'confirmed').length} confirmed</p></div>
    <div className="owner-request-tools"><select aria-label="Request type" value={type} onChange={e => setType(e.target.value)}><option value="all">All requests</option><option value="property">Property visits</option><option value="vehicle">Vehicle bookings</option></select><button className="text-link" disabled={busy} onClick={load}>Refresh</button><button className="save-button" disabled={busy || loading || !shown.length} onClick={() => { setRemoveError(''); setBulk({ token: user.token, ids: shown.map(row => row._id), kind: type }); }}>Delete All</button></div></div>
    {unavailable && <p className="form-error" role="alert">This request is unavailable or you do not have access.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}{loading ? <p>Loading customer requests…</p> : !shown.length ? <p>No requests in this category.</p> : <div className="owner-request-grid">{shown.map(row => <OwnerRequestCard key={row._id} row={row} highlighted={row === linkedRow} busy={busy} decide={decide} onRemove={row => { setRemoveError(''); setRemove(row); }} />)}</div>}
    {(remove || bulk) && <HistoryConfirmation bulk={Boolean(bulk)} removing ownerHistory busy={busy} error={removeError} onClose={closeRemove} onConfirm={bulk ? hideAll : hideRequest} />}
  </section>;
}

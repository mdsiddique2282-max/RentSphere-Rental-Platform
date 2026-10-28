import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { formatPrice } from '../data/listings';
import { requestToday, useLinkedRequest } from '../data/requests';
import { historyGroup, requestStatus, removeHistoryRequest, hideDashboardRequests } from '../data/requestHistory';
import CatalogImage from './CatalogImage';
import HistoryConfirmation from './HistoryConfirmation';
import './CustomerRequests.css';

export function RequestHistoryCard({ row, onCancel, onRemove, highlighted = false }) {
  const vehicle = row.listing?.type === 'vehicle' || (!row.listing && row.requestType !== 'property_visit' && row.requestType !== 'property_booking');
  return <article className="dashboard-request-card" id={`request-customer-${row._id}`} tabIndex={-1} style={highlighted ? { outline: '2px solid var(--blue)', outlineOffset: '3px' } : undefined}>
    <div className="request-card-head">
      <CatalogImage className="request-card-thumbnail" item={row.listing} src={row.listing?.image || row.listing?.gallery?.[0]} alt={row.listing?.title || row.listing?.name || 'Historical listing'} />
      <div><h3>{row.listing?.title || row.listing?.name || 'Listing no longer publicly available'}</h3><span className="status">{requestStatus(row)}</span></div>
    </div>
    <dl className="request-card-details">
      <dt>{row.requestType === 'property_visit' ? 'Visit date' : 'Booking dates'}</dt><dd>{row.startDate?.slice(0, 10)}{row.requestType !== 'property_visit' && ` – ${row.endDate?.slice(0, 10)}`}</dd>
      {vehicle ? <><dt>Amount</dt><dd>₹{formatPrice(row.totalPrice)}</dd><dt>Fulfilment</dt><dd>{row.fulfilment === 'delivery' ? `Home delivery: ${row.deliveryAddress} (₹${formatPrice(row.deliveryCharge || 0)})` : 'Self pickup'}</dd></> : <><dt>Owner decision</dt><dd>{row.status === 'confirmed' ? 'Visit accepted' : row.status === 'rejected' ? 'Visit rejected' : row.status === 'cancelled' ? 'Cancelled by you' : 'Awaiting decision'}{row.propertyDecision && ` · Your response: ${row.propertyDecision.kind}`}</dd></>}
      <dt>Created</dt><dd>{row.createdAt ? new Date(row.createdAt).toLocaleDateString('en-IN') : 'Historical request'}</dd>
    </dl>
    <div className="request-card-actions">
      {row.listing && <Link className="text-link" to={`/${row.listing.type === 'property' ? 'properties' : 'vehicles'}/${row.listing._id}`}>View listing</Link>}
      {['pending', 'confirmed'].includes(row.status) && row.startDate?.slice(0, 10) >= requestToday() && <button className="save-button" onClick={() => onCancel(row)}>Cancel request</button>}
      <button className="history-remove" aria-label="Remove request from history" title="Remove from history" onClick={() => onRemove(row)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg><span>Remove</span></button>
    </div>
  </article>;
}

export default function CustomerRequests() {
  const { user } = useContext(AuthContext);
  const location = useLocation();
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [kind, setKind] = useState('vehicle'), [group, setGroup] = useState('All'), [cancel, setCancel] = useState(null), [busy, setBusy] = useState(false);
  const [bulk, setBulk] = useState(null);
  const bulkLock = useRef(null);
  const [remove, setRemove] = useState(null), [actionError, setActionError] = useState('');
  const sequence = useRef(0);
  const tokenRef = useRef(user?.token); tokenRef.current = user?.token;
  const closeModal = useCallback(() => { setCancel(null); setRemove(null); setBulk(null); setActionError(''); }, []);
  const load = async () => {
    const token = user?.token;
    if (tokenRef.current !== token) return;
    const current = ++sequence.current;
    setError(''); setLoading(true);
    try {
      const response = await fetch('/api/bookings/mybookings', { headers: { Authorization: `Bearer ${user.token}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      if (current === sequence.current && tokenRef.current === token) setRows(data);
    } catch (e) { if (current === sequence.current) setError(e.message || 'Unable to load requests.'); }
    finally { if (current === sequence.current) setLoading(false); }
  };
  useEffect(() => { setRows([]); setBusy(false); closeModal(); if (user?.token) load(); return () => { ++sequence.current; }; }, [user?.token, closeModal]);
  const { linkedRow, unavailable } = useLinkedRequest({ search: location.search, view: 'customer', rows, loading, error, token: user?.token, setType: setKind, setGroup });
  const cancelRequest = async () => {
    if (busy || !cancel) return;
    const token = user.token;
    setBusy(true); setActionError('');
    try {
      const response = await fetch(`/api/bookings/${cancel._id}/cancel`, { method: 'PUT', headers: { Authorization: `Bearer ${user.token}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      if (tokenRef.current === token) { setCancel(null); await load(); }
    } catch (e) { if (tokenRef.current === token) setActionError(e.message || 'Unable to cancel request.'); }
    finally { setBusy(false); }
  };
  const removeRequest = async () => {
    if (busy || !remove) return;
    const token = user.token;
    setBusy(true); setActionError('');
    try {
      await removeHistoryRequest({ id: remove._id, token: user.token, onRemoved: id => {
        if (tokenRef.current !== token) return;
        ++sequence.current; setLoading(false); setRows(previous => previous.filter(row => row._id !== id));
      } });
      if (tokenRef.current === token) closeModal();
    } catch (e) { if (tokenRef.current === token) setActionError(e.message || 'Unable to remove request from history. Please try again.'); }
    finally { setBusy(false); }
  };
  const hideAll = async () => {
    if (busy || !bulk || bulk.token !== user.token || bulkLock.current === user.token) return;
    const token = user.token; bulkLock.current = token;
    setBusy(true); setActionError('');
    try {
      const ids = await hideDashboardRequests({ ...bulk, direction: 'customer', token });
      if (tokenRef.current !== token) return;
      ++sequence.current; setRows(previous => previous.filter(row => !ids.includes(row._id))); closeModal(); await load();
    } catch (error) { if (tokenRef.current === token) setActionError(error.message); }
    finally { if (bulkLock.current === token) bulkLock.current = null; if (tokenRef.current === token) setBusy(false); }
  };
  const shown = rows.filter(row => (row.listing?.type || (['property_visit', 'property_booking'].includes(row.requestType) ? 'property' : 'vehicle')) === kind && (group === 'All' || historyGroup(row) === group));
  return <section className="info-card dashboard-requests">
    <h2 tabIndex={-1}>My Bookings &amp; Visits</h2>
    <div className="request-history-toolbar">
      <button className={kind === 'vehicle' ? 'btn btn-primary' : 'save-button'} aria-pressed={kind === 'vehicle'} onClick={() => setKind('vehicle')}>My Vehicle Bookings</button>
      <button className={kind === 'property' ? 'btn btn-primary' : 'save-button'} aria-pressed={kind === 'property'} onClick={() => setKind('property')}>My Property Visits</button>
      <select className="request-status-filter" aria-label="Request history" value={group} onChange={e => setGroup(e.target.value)}>{['All', 'Pending requests', 'Upcoming / active', 'Past / completed', 'Rejected / cancelled'].map(value => <option key={value}>{value}</option>)}</select>
      <button className="save-button" disabled={busy} onClick={load}>Refresh</button>
      <button className="save-button" disabled={busy || loading || !shown.length} onClick={() => { setActionError(''); setBulk({ token: user.token, ids: shown.map(row => row._id), kind }); }}>Delete All</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {unavailable && <p className="form-error" role="alert">This request is unavailable or you do not have access.</p>}
    {loading ? <p>Loading your requests…</p> : !shown.length ? <p>No requests in this category.</p> : <div className="request-card-grid">{shown.map(row => <RequestHistoryCard key={row._id} row={row} highlighted={row === linkedRow} onCancel={row => { setActionError(''); setCancel(row); }} onRemove={row => { setActionError(''); setRemove(row); }} />)}</div>}
    {(cancel || remove || bulk) && <HistoryConfirmation bulk={Boolean(bulk)} removing={Boolean(remove)} busy={busy} error={actionError} onClose={closeModal} onConfirm={bulk ? hideAll : remove ? removeRequest : cancelRequest} />}
  </section>;
}

import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AuthContext } from '../context/AuthContext';
import CatalogImage from './CatalogImage';
import AdminRequestManage from './AdminRequestManage';
import { formatPrice } from '../data/listings';
import './AdminRequests.css';
import VehicleBookingFacts from './VehicleBookingFacts';

const statusLabels = { pending: 'Pending', confirmed: 'Confirmed', rejected: 'Rejected', cancelled: 'Cancelled' };
export const adminRequestCounts = rows => ({ total: rows.length, ...Object.fromEntries(['pending', 'confirmed', 'rejected'].map(status => [status, rows.filter(row => row.status === status).length])) });
export function filterAdminRequests(rows, search, status) {
  const query = search.trim().toLowerCase();
  return rows.filter(row => (status === 'all' || row.status === status) && [row.listing?.title, row.listing?.name,
    row.contact?.name, row.user?.name, row.listing?.host?.name, row.listing?.owner].some(value => String(value || '').toLowerCase().includes(query)));
}
export function selectedAdminRequestIds(shown, ids, archived = false) {
  const selected = new Set(ids);
  return shown.filter(row => Boolean(row.hiddenFromAdmin) === archived && selected.has(row._id)).map(row => row._id);
}
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Not recorded';
const createdDate = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not recorded';
const money = value => Number.isFinite(value) ? `₹${formatPrice(value)}` : 'Not recorded';

async function readResponse(response) {
  let data;
  try { data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null; }
  catch { throw new Error('Unable to read the server response. Please retry.'); }
  if (!response.ok || !data) throw Object.assign(new Error(data?.message || 'Unable to complete this request. Please try again.'), { status: response.status });
  return data;
}

// Keep requests sequential and reuse the same authorized, recoverable archive API.
export async function archiveAdminRequests({ ids, token, isCurrent, onProgress, send = fetch }) {
  const succeeded = [], failed = [];
  for (const id of new Set(ids)) {
    if (!isCurrent()) break;
    try {
      const response = await send(`/api/admin/requests/${id}/archive`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
      const result = await readResponse(response);
      if (String(result._id) !== String(id) || result.archived !== true) throw new Error('Archive could not be verified. Refresh before retrying.');
      succeeded.push(id);
    } catch (e) { failed.push({ id, message: e.message || 'Unable to archive this request.' }); }
    if (isCurrent()) onProgress(succeeded.length + failed.length);
  }
  return { succeeded, failed };
}

export async function hideArchivedAdminRequests({ ids, type, token, isCurrent, onProgress, send = fetch }) {
  const succeeded = [], failed = [], unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length && isCurrent(); offset += 200) {
    const batch = unique.slice(offset, offset + 200);
    try {
      const response = await send('/api/admin/requests/hide-archived', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ids: batch }) });
      const result = await readResponse(response);
      const reported = [...(Array.isArray(result.succeeded) ? result.succeeded : []), ...(Array.isArray(result.failed) ? result.failed.map(row => row.id) : [])];
      if (!Array.isArray(result.succeeded) || !Array.isArray(result.failed) || reported.length !== batch.length || new Set(reported).size !== batch.length || reported.some(id => !batch.includes(id))) throw new Error('Deletion could not be verified. Refresh before retrying.');
      succeeded.push(...result.succeeded); failed.push(...result.failed);
    } catch (e) { failed.push(...batch.map(id => ({ id, message: e.message || 'Unable to hide archived requests.' }))); }
    if (isCurrent()) onProgress(succeeded.length + failed.length);
  }
  return { succeeded, failed };
}

export function AdminArchiveConfirmation({ count, busy, progress, onClose, onConfirm, deleting = false, all = false }) {
  const dialog = useRef(), cancel = useRef(), busyRef = useRef(busy);
  busyRef.current = busy;
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const trigger = document.activeElement, overflow = document.body.style.overflow;
    const fallback = trigger?.closest('.admin-requests')?.querySelector('h2');
    document.body.style.overflow = 'hidden'; cancel.current?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose(); }
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keyboard); if (trigger?.isConnected) trigger.focus(); else fallback?.focus(); };
  }, [onClose]);
  const content = <div className="admin-manage-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busyRef.current) onClose(); }}>
    <section className="admin-manage-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
      <h2 id={titleId}>{deleting ? `Delete ${all ? 'ALL ' : ''}${count} archived requests?` : 'Archive/Delete Selected Requests'}</h2>
      <p id={descriptionId}>{deleting ? all ? 'This will hide all archived requests in the current management section from Admin Dashboard. The database records, booking statuses, Owner/User Dashboards and availability will remain unchanged. Only the confirmed request set is affected.' : 'These requests will be hidden from the Admin Dashboard but remain safely stored in the database. Owner and User Dashboards will not be affected.' : `Archive/Delete ${count} selected requests? These requests will be hidden from the Admin's active list. Owner and User Dashboards, request statuses, booking dates and availability will remain unchanged. You can restore these requests later.`}</p>
      {busy && <p role="status" aria-live="polite">{deleting ? 'Hiding' : 'Archiving'} {progress} of {count} requests…</p>}
      <div className="admin-manage-options"><button ref={cancel} type="button" className="save-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className={`btn btn-primary${deleting ? ' admin-request-delete' : ''}`} disabled={busy} onClick={onConfirm}>{busy ? deleting ? 'Hiding…' : 'Archiving…' : `${deleting ? all ? 'Delete All' : 'Delete' : 'Archive/Delete'} ${count} Requests`}</button></div>
    </section>
  </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export function AdminRequestCard({ row, vehicle, busy, processing, onDecide, onManage, selecting = false, selected = false, onSelect, archivedSelection = false }) {
  const listing = row.listing;
  const ownerName = listing?.host?.name || listing?.owner || (listing?.hostingDetailsVersion === 1 ? 'Owner details unavailable' : 'Admin-managed / predefined');
  const duration = row.startDate && row.endDate ? Math.max(1, Math.round((new Date(row.endDate) - new Date(row.startDate)) / 86400000)) : null;
  const interest = row.propertyDecision?.kind === 'interested' ? 'Interested' : row.propertyDecision?.kind === 'not-interested' ? 'Not Interested' : 'No Decision';
  const manageButton = <button type="button" className="admin-request-manage" disabled={busy} onClick={() => onManage(row)}>Manage</button>;
  return <article className={`admin-request-card${selected ? ' is-selected' : ''}`}>
    {selecting && Boolean(row.hiddenFromAdmin) === archivedSelection && <label className="admin-request-checkbox"><input type="checkbox" checked={selected} disabled={busy} onChange={() => onSelect(row._id)} /><span>Select {listing?.title || listing?.name || 'historical listing'} request for {row.contact?.name || row.user?.name || 'customer'}</span></label>}
    <header className="admin-request-card-header">
      <CatalogImage className="admin-request-thumbnail" item={listing} src={listing?.image || listing?.gallery?.[0]} alt={listing?.title || listing?.name || 'Historical listing'} loading="lazy" />
      <div className="admin-request-title"><small>{vehicle ? listing?.kind || 'Vehicle' : 'Property'}{listing?.category ? ` · ${listing.category}` : ''}</small>
        <h3>{(vehicle && row.vehicleSnapshot?.name) || listing?.title || listing?.name || 'Historical listing'}</h3><p>{(vehicle && (row.deliveryQuote?.pickupAddress || row.vehicleSnapshot?.pickupAddress)) || listing?.location || 'Location not recorded'}</p></div>
      <span className={`admin-request-status is-${row.status}`}>{statusLabels[row.status] || row.status}</span>
    </header>
    <div className="admin-request-people">
      <section><h4>Customer</h4><strong>{row.contact?.name || row.user?.name || 'Customer unavailable'}</strong><span>{row.contact?.email || row.user?.email || 'Email not recorded'}</span><span>{row.contact?.phone || 'Phone not recorded'}</span></section>
      <section><h4>Owner / managed by</h4><strong>{ownerName}</strong>{listing?.host?.email && <span>{listing.host.email}</span>}<span>{listing?.phone || 'Phone not recorded'}</span></section>
    </div>
    <dl className="admin-request-facts">
      <div><dt>{vehicle ? 'Pickup date' : 'Requested visit date'}</dt><dd>{date(row.startDate)}</dd></div>
      {vehicle ? <>
        <div><dt>Return date</dt><dd>{date(row.endDate)}</dd></div><div><dt>Duration</dt><dd>{duration ? `${duration} day${duration === 1 ? '' : 's'}` : 'Not recorded'}</dd></div>
        <div><dt>Fulfilment</dt><dd>{row.fulfilment === 'delivery' ? 'Home Delivery' : 'Self Pickup'}</dd></div>
        <VehicleBookingFacts row={row} admin />
      </> : <><div><dt>Monthly rent</dt><dd>{money(listing?.price)}</dd></div><div><dt>Customer interest</dt><dd>{interest}</dd></div></>}
    </dl>
    <footer className="admin-request-card-footer"><small>Created {createdDate(row.createdAt)}</small>
      {row.status === 'pending' && <div className="admin-request-actions">
        <button type="button" className="admin-request-accept" disabled={busy} onClick={() => onDecide(row, 'confirm')}>{processing === 'confirm' ? 'Processing…' : 'Accept'}</button>
        <button type="button" className="admin-request-reject" disabled={busy} onClick={() => onDecide(row, 'reject')}>{processing === 'reject' ? 'Processing…' : 'Reject'}</button>
        {manageButton}
      </div>}
      {row.status !== 'pending' && (row.status === 'confirmed' || row.status === 'rejected' || row.hiddenFromAdmin) && manageButton}
    </footer>
  </article>;
}

export default function AdminRequests({ type }) {
  const { user } = useContext(AuthContext);
  const [snapshot, setSnapshot] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [busy, setBusy] = useState(null), [notice, setNotice] = useState('');
  const [archived, setArchived] = useState(false), [managing, setManaging] = useState(null);
  const [selecting, setSelecting] = useState(false), [selection, setSelection] = useState(null), [confirmBulk, setConfirmBulk] = useState(false);
  const [progress, setProgress] = useState(0), [bulkTotal, setBulkTotal] = useState(0), [bulkError, setBulkError] = useState('');
  const [deletePlan, setDeletePlan] = useState(null);
  const closeDelete = useCallback(() => setDeletePlan(null), []);
  const closeBulk = useCallback(() => setConfirmBulk(false), []);
  const closeManage = useCallback(() => setManaging(null), []);
  const scope = `${user?.token || ''}:${type}:${archived}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const sequence = useRef(0), actionLock = useRef(false);
  const vehicle = type === 'vehicle';
  const rows = snapshot?.scope === scope ? snapshot.rows : [];
  const shown = filterAdminRequests(rows, search, status);
  const selectionKey = JSON.stringify([scope, search, status]);
  const selectedIds = selectedAdminRequestIds(shown, selection?.key === selectionKey ? selection.ids : [], archived);
  const eligible = shown.filter(row => Boolean(row.hiddenFromAdmin) === archived);
  const selectAll = useRef();
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedIds.length > 0 && selectedIds.length < eligible.length; }, [selectedIds.length, eligible.length]);
  useEffect(() => { if (!selectedIds.length && busy?.action !== 'archive') setConfirmBulk(false); }, [selectedIds.length, busy?.action]);
  const clearSelection = () => { setSelection(null); setConfirmBulk(false); setDeletePlan(null); setBulkError(''); };
  const toggleSelection = id => setSelection(previous => {
    const ids = selectedAdminRequestIds(shown, previous?.key === selectionKey ? previous.ids : [], archived);
    return { key: selectionKey, ids: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] };
  });
  const load = useCallback(async (background = false) => {
    if (!user?.token || user.role !== 'admin') return false;
    const current = ++sequence.current;
    if (!background) setLoading(true);
    try {
      const response = await fetch(`/api/admin/requests?type=${type}${archived ? '&archived=true' : ''}`, { headers: { Authorization: `Bearer ${user.token}` }, cache: 'no-store' });
      const data = await readResponse(response);
      if (!Array.isArray(data)) throw new Error('Unable to load requests. Please retry.');
      if (scopeRef.current === scope && current === sequence.current) { setSnapshot({ scope, rows: data }); setError(''); }
      return true;
    } catch (e) { if (scopeRef.current === scope && current === sequence.current) setError(e.message); return false; }
    finally { if (scopeRef.current === scope && current === sequence.current) setLoading(false); }
  }, [scope, user?.token, user?.role, type, archived]);
  useEffect(() => {
    scopeRef.current = scope;
    setSnapshot(null); setError(''); setNotice(''); setSearch(''); setStatus('all'); setBusy(null); actionLock.current = false;
    setManaging(null);
    setSelecting(false); setSelection(null); setConfirmBulk(false); setBulkError(''); setProgress(0);
    setDeletePlan(null);
    load();
    const refresh = () => load(true);
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => { ++sequence.current; if (scopeRef.current === scope) scopeRef.current = ''; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  const decide = async (row, action) => {
    if (actionLock.current || row.status !== 'pending' || !user?.token || user.role !== 'admin') return;
    actionLock.current = true; setBusy({ id: row._id, action }); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/requests/${row._id}/${action}`, { method: 'PUT', headers: { Authorization: `Bearer ${user.token}` } });
      const updated = await readResponse(response);
      if (String(updated._id) !== String(row._id) || updated.status !== (action === 'confirm' ? 'confirmed' : 'rejected')) throw new Error('The decision could not be verified. Please refresh this request.');
      if (scopeRef.current !== scope) return;
      setSnapshot(previous => previous?.scope === scope ? { ...previous, rows: previous.rows.map(item => item._id === row._id ? { ...item, status: updated.status,
        totalPrice: updated.totalPrice, deliveryCharge: updated.deliveryCharge, propertyDecision: updated.propertyDecision || item.propertyDecision } : item) } : previous);
      setNotice(action === 'confirm' ? 'Request accepted successfully.' : 'Request rejected successfully.');
      await load(true);
    } catch (e) {
      if (scopeRef.current !== scope) return;
      const refreshed = await load(true);
      if (scopeRef.current === scope) setError(e.status === 409 ? `${e.message} ${refreshed ? 'The latest request status is shown below.' : 'Retry to retrieve the latest status.'}` : e.message);
    } finally { if (scopeRef.current === scope) { actionLock.current = false; setBusy(null); } }
  };
  const bulkArchive = async () => {
    if (actionLock.current || !confirmBulk || archived || loading || !selectedIds.length || user?.role !== 'admin' || !user.token) return;
    actionLock.current = true; setBusy({ action: 'archive' }); setProgress(0); setBulkTotal(selectedIds.length); setNotice(''); setBulkError('');
    try {
      const result = await archiveAdminRequests({ ids: selectedIds, token: user.token, isCurrent: () => scopeRef.current === scope,
        onProgress: completed => setProgress(completed) });
      if (scopeRef.current !== scope) return;
      setConfirmBulk(false);
      setSnapshot(previous => previous?.scope === scope ? { ...previous, rows: previous.rows.filter(row => !result.succeeded.includes(row._id)) } : previous);
      setSelection({ key: selectionKey, ids: result.failed.map(row => row.id) });
      setSelecting(Boolean(result.failed.length));
      const summary = `${result.succeeded.length} requests archived successfully.`;
      if (result.failed.length) setBulkError(`${summary} ${result.failed.length} failed. Failed requests remain selected where still visible; retry after checking their latest status. ${[...new Set(result.failed.map(row => row.message))].join(' ')}`);
      else setNotice(summary);
      await load(true);
    } finally { if (scopeRef.current === scope) { actionLock.current = false; setBusy(null); } }
  };
  const prepareDelete = async all => {
    if (actionLock.current || !archived || loading || user?.role !== 'admin' || !user.token) return;
    if (!all) { if (selectedIds.length) setDeletePlan({ scope, all: false, ids: [...selectedIds] }); return; }
    actionLock.current = true; setBusy({ action: 'prepare-delete' }); setBulkError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/requests/archived-set?type=${type}`, { headers: { Authorization: `Bearer ${user.token}` }, cache: 'no-store' });
      const data = await readResponse(response);
      if (scopeRef.current !== scope) return;
      if (data.type !== type || !Array.isArray(data.ids) || data.count !== data.ids.length || new Set(data.ids).size !== data.ids.length || data.ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw new Error('Unable to verify the archived request set. Please retry.');
      if (!data.count) { setNotice('No archived requests to delete in this section.'); await load(true); }
      else setDeletePlan({ scope, all: true, ids: [...data.ids] });
    } catch (e) { if (scopeRef.current === scope) setBulkError(e.message || 'Unable to prepare archived requests.'); }
    finally { if (scopeRef.current === scope) { actionLock.current = false; setBusy(null); } }
  };
  const deleteArchived = async () => {
    if (actionLock.current || !archived || deletePlan?.scope !== scope || !deletePlan.ids.length || user?.role !== 'admin' || !user.token) return;
    actionLock.current = true; setBusy({ action: 'delete' }); setProgress(0); setNotice(''); setBulkError('');
    try {
      const result = await hideArchivedAdminRequests({ ids: deletePlan.ids, type, token: user.token,
        isCurrent: () => scopeRef.current === scope, onProgress: completed => setProgress(completed) });
      if (scopeRef.current !== scope) return;
      setDeletePlan(null);
      setSnapshot(previous => previous?.scope === scope ? { ...previous, rows: previous.rows.filter(row => !result.succeeded.includes(row._id)) } : previous);
      setSelection({ key: selectionKey, ids: result.failed.map(row => row.id) });
      const summary = `${result.succeeded.length} requests hidden from Admin Dashboard. Database records preserved.`;
      if (result.failed.length) setBulkError(`${summary} ${result.failed.length} failed. Requests still matching your filters remain selected for retry. ${[...new Set(result.failed.map(row => row.message))].join(' ')}`);
      else setNotice(summary);
      await load(true);
    } finally { if (scopeRef.current === scope) { actionLock.current = false; setBusy(null); } }
  };
  if (!user || user.role !== 'admin') return <p role="alert">Admin access required.</p>;
  const counts = adminRequestCounts(rows);
  const managedRow = managing?.scope === scope ? rows.find(row => row._id === managing.id) : null;
  return <section className="admin-requests" aria-label={vehicle ? 'Vehicle Bookings management' : 'Property Visits management'}>
    <header className="admin-requests-heading"><div><span className="eyebrow">Request management</span><h2 tabIndex={-1}>{vehicle ? 'Vehicle Bookings' : 'Property Visits'}</h2><p>{vehicle ? 'Manage vehicle rental requests across RentSphere.' : 'Manage property visit requests across RentSphere.'}</p></div><div className="admin-request-view-actions"><button type="button" className="save-button" disabled={Boolean(busy)} aria-pressed={archived} onClick={() => setArchived(value => !value)}>{archived ? "Active requests" : "Archived requests"}</button><button className="save-button" type="button" disabled={loading || Boolean(busy)} onClick={() => load()}>Refresh</button></div></header>
    <div className="admin-request-summary">{[['total', 'Total Requests'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected']].map(([key, label]) => <article key={key} className={`admin-request-metric is-${key}`}><span>{label}</span><strong>{snapshot?.scope === scope ? counts[key] : '—'}</strong></article>)}</div>
    <div className="admin-request-filters"><label>Search requests<input type="search" value={search} placeholder="Listing, customer or owner name" disabled={Boolean(busy)} onChange={e => { setSearch(e.target.value); clearSelection(); }} /></label><label>Status<select value={status} disabled={Boolean(busy)} onChange={e => { setStatus(e.target.value); clearSelection(); }}>{[['all', 'All'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{!archived && <button type="button" className="admin-request-manage admin-bulk-toggle" disabled={loading || Boolean(busy) || selecting} onClick={() => { clearSelection(); setNotice(''); setSelecting(true); }}>Archive/Delete</button>}</div>
    {(selecting || archived) && <div className="admin-bulk-toolbar" aria-label="Bulk request selection">
      <label className="admin-request-checkbox"><input ref={selectAll} type="checkbox" checked={eligible.length > 0 && selectedIds.length === eligible.length} disabled={Boolean(busy) || loading || !eligible.length} onChange={event => { setSelection({ key: selectionKey, ids: event.target.checked ? eligible.map(row => row._id) : [] }); setConfirmBulk(false); }} />Select All</label>
      <span role="status" aria-live="polite">{selectedIds.length} requests selected</span>
      {archived ? <>
        <button type="button" className="admin-request-manage admin-request-delete" disabled={!selectedIds.length || loading || Boolean(busy)} onClick={() => prepareDelete(false)}>Delete Selected ({selectedIds.length})</button>
        <button type="button" className="admin-request-manage admin-request-delete" disabled={loading || Boolean(busy)} onClick={() => prepareDelete(true)}>{busy?.action === 'prepare-delete' ? 'Checking all archived requests...' : 'Delete All'}</button>
      </> : <>
        <button type="button" className="admin-request-manage" disabled={!selectedIds.length || loading || Boolean(busy)} onClick={() => setConfirmBulk(true)}>Archive/Delete Selected ({selectedIds.length})</button>
        <button type="button" className="save-button" disabled={Boolean(busy)} onClick={() => { clearSelection(); setSelecting(false); }}>Cancel</button>
      </>}
    </div>}
    {bulkError && <p className="admin-request-feedback is-error" role="alert">{bulkError}</p>}
    {notice && <p className="admin-request-feedback is-success" role="status">{notice}</p>}
    {error && <div className="admin-request-feedback is-error" role="alert">{error} <button type="button" disabled={loading || Boolean(busy)} onClick={() => load()}>Retry</button></div>}
    {loading ? <div className="admin-request-empty" role="status">Loading {vehicle ? 'vehicle bookings' : 'property visit requests'}…</div> : error && snapshot?.scope !== scope ? null : !shown.length ? <div className="admin-request-empty">{status === 'pending' && !search ? 'No pending requests.' : search || status !== 'all' ? 'No requests match your filters.' : vehicle ? 'No vehicle bookings found.' : 'No property visit requests found.'}</div> : <div className="admin-request-list">{shown.map(row => <AdminRequestCard key={row._id} row={row} vehicle={vehicle} busy={Boolean(busy)} processing={busy?.id === row._id ? busy.action : null} onDecide={decide} selecting={selecting || archived} archivedSelection={archived} selected={selectedIds.includes(row._id)} onSelect={toggleSelection} onManage={row => setManaging({ scope, id: row._id })} />)}</div>}
    {confirmBulk && (selectedIds.length > 0 || busy?.action === 'archive') && !archived && <AdminArchiveConfirmation count={busy?.action === 'archive' ? bulkTotal : selectedIds.length} busy={busy?.action === 'archive'} progress={progress} onClose={closeBulk} onConfirm={bulkArchive} />}
    {deletePlan?.scope === scope && archived && <AdminArchiveConfirmation deleting all={deletePlan.all} count={deletePlan.ids.length} busy={busy?.action === 'delete'} progress={progress} onClose={closeDelete} onConfirm={deleteArchived} />}
    {managedRow && <AdminRequestManage key={scope + ':' + managedRow._id} row={managedRow} token={user.token} readResponse={readResponse} onClose={closeManage} onListingChanged={() => load(true)} onArchived={async hidden => {
      if (scopeRef.current !== scope) return;
      closeManage(); setNotice(hidden ? 'Request archived. View and restore it under Archived requests.' : 'Request restored to the active list.');
      setSnapshot(previous => previous?.scope === scope ? { ...previous, rows: previous.rows.filter(row => row._id !== managedRow._id) } : previous);
      await load(true);
    }} />}
  </section>;
}

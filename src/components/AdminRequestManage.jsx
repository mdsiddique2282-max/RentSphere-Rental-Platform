import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isListingUnavailable } from '../data/detailHeader';

export default function AdminRequestManage({ row, token, readResponse, onClose, onArchived, onListingChanged }) {
  const [listing, setListing] = useState(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmArchive, setConfirmArchive] = useState(false);
  const dialog = useRef(), closeButton = useRef(), cancelArchive = useRef(), locked = useRef(false), mounted = useRef(false);
  const titleId = useId(), descriptionId = useId();
  const listingId = row.listing?._id;
  const vehicle = row.listing?.type === 'vehicle' || row.requestType === 'vehicle';
  useEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement, fallback = trigger?.closest('.admin-requests')?.querySelector('h2');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!locked.current) onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      if (!controls.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { mounted.current = false; document.body.style.overflow = overflow; document.removeEventListener('keydown', keyboard); if (trigger?.isConnected) trigger.focus(); else fallback?.focus(); };
  }, [onClose]);
  useEffect(() => { if (confirmArchive) cancelArchive.current?.focus(); }, [confirmArchive]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    setLoading(true); setError('');
    if (!listingId) { setLoading(false); setError('This historical listing is unavailable. You can still archive or restore the request.'); return; }
    const load = async () => {
      try {
        const response = await fetch(`/api/listings/${listingId}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
        const data = await readResponse(response);
        if (String(data._id) !== String(listingId)) throw new Error('Unable to verify this listing. Please reopen the request.');
        if (active) setListing(data);
      } catch (e) { if (active) setError(e.message || 'Unable to load listing availability. You can still archive or restore the request.'); }
      finally { if (active) setLoading(false); }
    };
    load();
    return () => { active = false; controller.abort(); };
  }, [listingId, token, readResponse]);

  const changeAvailability = async available => {
    if (locked.current || !listing || loading) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/listings/${listing._id}/availability`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ available }) });
      const updated = await readResponse(response);
      if (!mounted.current) return;
      if (String(updated._id) !== String(listing._id)) throw new Error('The availability update could not be verified. Reopen this request to refresh.');
      setListing(updated);
      setNotice((!isListingUnavailable(updated)) === available ? `Listing marked ${available ? 'Available' : 'Unavailable'}. Request history is unchanged.` : 'The listing remains unavailable under its existing availability rules.');
      await onListingChanged();
    } catch (e) { if (mounted.current) setError(e.message || 'Unable to change listing availability.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const archive = async () => {
    if (locked.current || (!row.hiddenFromAdmin && !confirmArchive)) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const archived = !row.hiddenFromAdmin;
      const response = await fetch(`/api/admin/requests/${row._id}/archive`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) });
      const result = await readResponse(response);
      if (!mounted.current) return;
      if (String(result._id) !== String(row._id) || result.archived !== archived) throw new Error('The archive change could not be verified. Please retry.');
      await onArchived(archived);
    } catch (e) { if (mounted.current) setError(e.message || 'Unable to archive or restore this request.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const unavailable = listing && isListingUnavailable(listing);
  const content = <div className="admin-manage-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !locked.current) onClose(); }}>
    <section className="admin-manage-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
      <button ref={closeButton} type="button" className="admin-manage-close" aria-label="Close Manage Request" disabled={busy} onClick={onClose}>×</button>
      <span className="eyebrow">Request management</span><h2 id={titleId}>Manage Request</h2><p id={descriptionId}>Manage admin visibility and listing availability without changing this request.</p>
      <dl className="admin-manage-details"><div><dt>Listing</dt><dd>{row.listing?.title || row.listing?.name || 'Historical listing'}</dd></div><div><dt>Customer</dt><dd>{row.contact?.name || row.user?.name || 'Customer unavailable'}</dd></div><div><dt>Request status</dt><dd><span className={`admin-request-status is-${row.status}`}>{row.status === 'confirmed' ? 'Confirmed' : row.status === 'rejected' ? 'Rejected' : row.status}</span></dd></div><div><dt>Listing Availability</dt><dd>{loading ? 'Checking availability…' : listing ? unavailable ? 'Unavailable' : 'Available' : 'Listing unavailable'}</dd></div></dl>
      {error && <p className="admin-request-feedback is-error" role="alert">{error}</p>}{notice && <p className="admin-request-feedback is-success" role="status">{notice}</p>}
      <section className="admin-manage-section"><h3>Listing Availability</h3><p>{vehicle ? 'Manual listing availability is separate from booked dates. Confirmed bookings and calendars will remain unchanged.' : 'This is a listing-level action. Existing visit requests and customer interest decisions are preserved.'}</p>
        {!vehicle && listing?.interestUnavailable && <p className="admin-manage-hold">An Interested decision currently holds this property unavailable. Explicitly choosing Available uses the existing manual Make Available control; saved interest decisions are retained.</p>}
        <div className="admin-manage-options"><button type="button" className="save-button" disabled={busy || loading || !listing || !unavailable} onClick={() => changeAvailability(true)}>Available</button><button type="button" className="save-button" disabled={busy || loading || !listing || Boolean(unavailable)} onClick={() => changeAvailability(false)}>Unavailable</button></div>
      </section>
      <section className="admin-manage-section"><h3>{row.hiddenFromAdmin ? 'Restore Request' : 'Archive Request'}</h3><p>Only the Admin request list changes. Customer and owner history, notifications, decisions and booked dates stay unchanged.</p>
        {confirmArchive ? <div className="admin-manage-confirm"><p>Archive this request from the active Admin list? You can view and restore it under Archived requests.</p><div className="admin-manage-options"><button type="button" ref={cancelArchive} className="save-button" disabled={busy} onClick={() => setConfirmArchive(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={archive}>{busy ? 'Archiving…' : 'Confirm archive'}</button></div></div>
          : <button type="button" className="save-button" disabled={busy} onClick={() => row.hiddenFromAdmin ? archive() : setConfirmArchive(true)}>{busy ? 'Saving…' : row.hiddenFromAdmin ? 'Restore Request' : 'Archive/Delete Request'}</button>}
      </section>
    </section>
  </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

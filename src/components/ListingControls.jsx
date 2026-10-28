import { ownerListingTypes } from '../data/ownerPolicy';
import { useContext, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { isListingUnavailable } from '../data/detailHeader';
import VehicleCalendar from './VehicleCalendar';
import HostingForm from './HostingForm';

export default function ListingControls({ item, onChanged, allowEdit = false }) {
  const { user } = useContext(AuthContext);
  const [editing, setEditing] = useState(false), [calendar, setCalendar] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mutate = async (path, body) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/listings/${item._id}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      setEditing(false); await onChanged();
    } catch (e) { setError(e.message || 'Unable to update listing.'); }
    finally { setBusy(false); }
  };
  return <div>
    <small>{isListingUnavailable(item) ? 'Unavailable' : 'Available'}</small>
    <div className="decision-actions">
      <button className="save-button" disabled={busy} onClick={() => mutate('/availability', { available: isListingUnavailable(item) })}>Make {isListingUnavailable(item) ? 'available' : 'unavailable'}</button>
      {allowEdit && (user.role === 'admin' || ownerListingTypes(user.ownerProfile).includes(item.type)) && <button className="save-button" onClick={() => setEditing(true)}>Edit listing</button>}
      {item.type === 'vehicle' && <button className="text-link" onClick={() => setCalendar(!calendar)}>{calendar ? 'Hide calendar' : 'Booking calendar'}</button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {calendar && <VehicleCalendar key={user?.token} item={item} managementToken={user?.role === 'owner' && String(item.host?._id || item.host) === String(user._id) ? user.token : undefined} onReleased={onChanged} />}
    {editing && <div className="modal-backdrop"><section className="booking-modal owner-edit-modal" role="dialog" aria-modal="true" aria-label="Edit listing" onMouseDown={e => e.stopPropagation()}>
      <button className="modal-close" aria-label="Close edit listing" disabled={busy} onClick={() => setEditing(false)}>×</button><h2>Edit your listing</h2>
      <HostingForm key={item._id} item={item} token={user.token} onBusyChange={setBusy} onSaved={async () => { setEditing(false); await onChanged(); }} />
    </section></div>}
  </div>;
}

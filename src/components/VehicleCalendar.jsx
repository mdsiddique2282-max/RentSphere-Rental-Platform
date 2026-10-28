import { useCallback, useEffect, useRef, useState } from 'react';
import { requestToday } from '../data/requests';
import { calendarWindow, shiftCalendarMonth, vehicleDateState, vehicleRangeAvailable, selectVehicleDate, releasableBooking } from '../data/vehicleCalendar';
import './VehicleCalendar.css';
import HistoryConfirmation from './HistoryConfirmation';
import { vehicleBookingDisplay } from '../data/detailHeader';

export function VehicleCalendarDays({ month, data, today, startDate = '', endDate = '', field = 'start', onBooked, onSelect }) {
  const first = new Date(month + '-01T00:00:00Z');
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return <div className="vehicle-calendar-grid">
    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <small key={day}>{day}</small>)}
    {Array.from({ length: first.getUTCDay() }, (_, index) => <span key={'blank-' + index} />)}
    {Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}`;
      const state = data ? vehicleDateState(date, data, today) : 'loading';
      const crossesBooking = state === 'available' && field === 'end' && startDate && date >= startDate && !vehicleRangeAvailable(startDate, date, data, today);
      const selected = date === startDate || date === endDate;
      const inRange = startDate && endDate && date > startDate && date < endDate;
      const label = crossesBooking ? 'Range crosses a confirmed booking' : state;
      return <button key={date} type="button" className={`vehicle-calendar-day is-${state}${selected ? ' is-selected' : ''}${inRange ? ' is-in-range' : ''}`}
        title={`${date}: ${label}`} aria-label={`${date}: ${label}`} aria-pressed={selected}
        disabled={state === 'booked' ? !onBooked || !releasableBooking(date, data, today) : !onSelect || state !== 'available' || Boolean(crossesBooking)} onClick={() => state === 'booked' ? onBooked?.(date) : onSelect?.(date)}>{index + 1}</button>;
    })}
  </div>;
}

export default function VehicleCalendar({ item, startDate = '', endDate = '', onChange, managementToken, onReleased }) {
  const [release, setRelease] = useState(null), [busy, setBusy] = useState(false), [actionError, setActionError] = useState(''), [success, setSuccess] = useState(''), [revision, setRevision] = useState(0);
  const actionLock = useRef(false);
  const closeRelease = useCallback(() => { setRelease(null); setActionError(''); }, []);
  const [month, setMonth] = useState(requestToday().slice(0, 7));
  const [field, setField] = useState('start');
  const [loaded, setLoaded] = useState(null), [error, setError] = useState('');
  const id = String(item._id || item.id || '');
  const { from, to } = calendarWindow(month, startDate, endDate);
  const key = `${id}:${from}:${to}:${managementToken || "public"}`;
  const data = loaded?.key === key ? loaded.data : null;
  useEffect(() => {
    if (!/^[a-f\d]{24}$/i.test(id)) return;
    let active = true, sequence = 0;
    const controller = new AbortController();
    setLoaded(null); setError('');
    const load = async () => {
      const current = ++sequence;
      try {
        const response = await fetch(`/api/listings/${id}/availability?from=${from}&to=${to}${managementToken ? '&manage=true' : ''}`, { signal: controller.signal, cache: 'no-store', ...(managementToken ? { headers: { Authorization: `Bearer ${managementToken}` } } : {}) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || 'Unable to load availability.');
        if (!Array.isArray(body.bookedRanges)) throw new Error('Unable to load availability.');
        if (active && sequence === current) { setLoaded({ key, data: body }); setError(''); }
      } catch (e) { if (active && sequence === current) { setLoaded(null); setError(e.message || 'Unable to load availability.'); } }
    };
    load();
    window.addEventListener('focus', load);
    const timer = window.setInterval(load, 15000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', load); };
  }, [id, from, to, key, managementToken, revision]);
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  const today = requestToday();
  const summary = data && vehicleBookingDisplay({ status: 'available', available: data.available, vehicleBookingStatus: data.vehicleBookingStatus });
  const select = date => {
    const selection = selectVehicleDate(date, field, startDate, endDate, data, today);
    if (selection) { onChange({ start: selection.start, end: selection.end }); setField(selection.field); }
  };
  const releaseDates = async () => {
    if (!release || actionLock.current || !managementToken) return;
    actionLock.current = true; setBusy(true); setActionError(''); setSuccess('');
    try {
      const response = await fetch('/api/bookings/' + release._id + '/release-dates', { method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + managementToken }, body: JSON.stringify({ selectedDate: release.selectedDate }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Unable to make dates available.');
      closeRelease(); setLoaded(null); setRevision(value => value + 1); setSuccess('Booking cancelled. Calendar availability has been updated.'); onReleased?.();
    } catch (error) { setActionError(error.message || 'Unable to make dates available. Refresh and retry.'); }
    finally { actionLock.current = false; setBusy(false); }
  };
  return <section className="vehicle-calendar" aria-label="Vehicle availability calendar" aria-busy={!data && !error}>
    <div className="vehicle-calendar-heading"><h3>Vehicle availability</h3><div className="vehicle-calendar-nav">
      <button type="button" aria-label="Previous month" disabled={month <= today.slice(0, 7)} onClick={() => setMonth(shiftCalendarMonth(month, -1))}>‹</button>
      <label><span className="vehicle-calendar-sr-only">Month</span><input type="month" min={today.slice(0, 7)} value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value) && e.target.value >= today.slice(0, 7)) setMonth(e.target.value); }} /></label>
      <button type="button" aria-label="Next month" onClick={() => setMonth(shiftCalendarMonth(month, 1))}>›</button>
    </div></div>
    {summary && <p className={`vehicle-status vehicle-status--${summary.state}`}>{summary.label}</p>}
    {onChange && <div className="vehicle-calendar-selection">
      <button type="button" aria-pressed={field === 'start'} onClick={() => setField('start')}><small>Pickup date</small><strong>{startDate || 'Choose date'}</strong></button>
      <button type="button" aria-pressed={field === 'end'} onClick={() => setField('end')}><small>Return date</small><strong>{endDate || 'Choose date'}</strong></button>
    </div>}
    {success && <p className="vehicle-calendar-note" role="status">{success}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data && !error && <p className="vehicle-calendar-note" role="status">Loading availability…</p>}
    {data && !data.available && <p className="vehicle-calendar-note">Listing manually unavailable. Existing bookings are preserved.</p>}
    <VehicleCalendarDays month={month} data={data} today={today} startDate={startDate} endDate={endDate} field={field} onBooked={managementToken && !busy ? date => { const booking = releasableBooking(date, data, today); if (booking) { setActionError(''); setRelease({ ...booking, selectedDate: date }); } } : undefined} onSelect={onChange ? select : undefined} />
    <div className="vehicle-calendar-legend"><span className="legend-available">Available</span><span className="legend-booked">Booked</span><span className="legend-past">Past / unavailable</span>{onChange && <span className="legend-selected">Selected</span>}</div>
    {release && <HistoryConfirmation release={release} busy={busy} error={actionError} onClose={closeRelease} onConfirm={releaseDates} />}
    <p className="vehicle-calendar-note">Pickup and return dates are included. Pending requests do not reserve dates.</p>
  </section>;
}

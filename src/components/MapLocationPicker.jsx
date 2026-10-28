import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCoordinates, reverseAddress, searchAddresses } from '../data/coordinates';
import 'leaflet/dist/leaflet.css';
import './MapLocationPicker.css';

const key = import.meta.env.VITE_GEOAPIFY_API_KEY;
export default function MapLocationPicker({ initialCoordinates, initialAddress = '', onConfirm, onClose }) {
  const initial = useRef(isCoordinates(initialCoordinates) ? { ...initialCoordinates } : null);
  const [coordinates, setCoordinates] = useState(initial.current), [address, setAddress] = useState(initialAddress);
  const [resolving, setResolving] = useState(false), [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(''), [suggestions, setSuggestions] = useState([]), [searchError, setSearchError] = useState('');
  const [error, setError] = useState(''), [mapError, setMapError] = useState('');
  const container = useRef(), dialog = useRef(), cancel = useRef(), map = useRef(), marker = useRef(), leaflet = useRef();
  const abort = useRef(), revision = useRef(0), alive = useRef(false), point = useRef(initial.current);
  const titleId = useId(), hintId = useId();
  const resolve = useCallback(async selected => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const current = ++revision.current; setResolving(true); setError('');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      const resolved = await reverseAddress(selected, { key, signal: controller.signal });
      if (alive.current && current === revision.current) setAddress(resolved);
    } catch (e) { if (alive.current && current === revision.current && (timedOut || e.name !== 'AbortError')) setError(timedOut ? 'Address lookup timed out. Retry or enter the address for your selected pin.' : e.message); }
    finally { clearTimeout(timer); if (alive.current && current === revision.current) setResolving(false); }
  }, []);
  const selectPoint = useCallback(selected => {
    if (!isCoordinates(selected)) return;
    point.current = { ...selected }; setCoordinates({ ...selected }); setAddress('');
    const L = leaflet.current;
    if (marker.current) marker.current.setLatLng([selected.lat, selected.lon]);
    else if (L && map.current) {
      marker.current = L.marker([selected.lat, selected.lon], { draggable: true, autoPan: true, title: 'Selected location',
        icon: L.divIcon({ className: 'location-map-marker', html: '<span aria-hidden="true"></span>', iconSize: [30, 40], iconAnchor: [15, 40] }) }).addTo(map.current);
      marker.current.on('dragend', () => { const p = marker.current.getLatLng().wrap(); selectPoint({ lat: p.lat, lon: p.lng }); });
    }
    resolve(selected);
  }, [resolve]);
  useEffect(() => {
    alive.current = true;
    const trigger = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; cancel.current?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => { alive.current = false; ++revision.current; abort.current?.abort(); document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keyboard, true); if (trigger?.isConnected) trigger.focus(); };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    const boot = async () => {
      if (!key) { setLoading(false); setMapError('Map service is not configured. Cancel to use the existing address field.'); return; }
      try {
        const L = await import('leaflet'); if (!active) return; leaflet.current = L;
        const saved = initial.current;
        const view = L.map(container.current, { keyboard: true }).setView(saved ? [saved.lat, saved.lon] : [20.5937, 78.9629], saved ? 16 : 5);
        map.current = view;
        L.tileLayer(`https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(key)}`, {
          maxZoom: 20, attribution: '<a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> | <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
        }).on('tileerror', () => { if (active) setMapError('Some map tiles could not load. Check your connection or close and reopen the map.'); }).addTo(view);
        view.on('click', event => { const p = event.latlng.wrap(); selectPoint({ lat: p.lat, lon: p.lng }); });
        if (saved) {
          marker.current = L.marker([saved.lat, saved.lon], { draggable: true, autoPan: true, title: 'Saved selected location',
            icon: L.divIcon({ className: 'location-map-marker', html: '<span aria-hidden="true"></span>', iconSize: [30, 40], iconAnchor: [15, 40] }) }).addTo(view);
          marker.current.on('dragend', () => { const p = marker.current.getLatLng().wrap(); selectPoint({ lat: p.lat, lon: p.lng }); });
        }
        view.invalidateSize(); setLoading(false);
      } catch { if (active) { setLoading(false); setMapError('The map could not load. Close and reopen it, or use the existing address field.'); } }
    };
    boot();
    return () => { active = false; marker.current?.off(); marker.current = null; map.current?.off(); map.current?.remove(); map.current = null; };
  }, [selectPoint]);
  useEffect(() => {
    setSuggestions([]); setSearchError('');
    if (search.trim().length < 3) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try { const rows = await searchAddresses(search, { key, signal: controller.signal }); if (active) setSuggestions(rows); }
      catch (error) { if (active && error.name !== 'AbortError') setSearchError(error.message); }
    }, 350);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [search]);
  const content = <div className="location-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="location-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}>
      <button type="button" className="location-picker-close" aria-label="Close map picker" onClick={onClose}>×</button>
      <span className="eyebrow">Choose an exact location</span><h2 id={titleId}>Select location on map</h2>
      <p id={hintId}>Click the map or drag the pin. With a keyboard, focus the map, use arrow keys to pan and + / − to zoom, then choose the map centre.</p>
      {loading && <p role="status">Loading map…</p>}{mapError && <p className="form-error" role="alert">{mapError}</p>}
      <label className="location-picker-address address-autocomplete">Search address<input value={search} maxLength={500} placeholder="Search for an address" onChange={event => setSearch(event.target.value)} />
        {suggestions.length > 0 && <ul className="address-suggestions">{suggestions.map((row, index) => <li key={index}><button type="button" disabled={loading} onClick={() => { setSearch(''); setSuggestions([]); map.current?.setView([row.lat, row.lon], 16); selectPoint({ lat: row.lat, lon: row.lon }); }}>{row.formatted}</button></li>)}</ul>}
      </label>
      {searchError && <p className="form-error" role="alert">{searchError}</p>}
      <div ref={container} className="location-picker-map" aria-label="Location map. Arrow keys pan; plus and minus zoom." />
      <button type="button" className="save-button location-picker-centre" disabled={loading || Boolean(mapError)} onClick={() => { const p = map.current?.getCenter().wrap(); if (p) selectPoint({ lat: p.lat, lon: p.lng }); }}>Choose map centre</button>
      <p className="location-picker-position" role="status">{coordinates ? `Selected pin: ${coordinates.lat.toFixed(6)}, ${coordinates.lon.toFixed(6)}` : 'No pin selected. The initial map view is for navigation only.'}</p>
      <label className="location-picker-address">Review address<textarea maxLength={500} rows={2} value={address} onChange={event => {
        ++revision.current; abort.current?.abort(); setResolving(false); setAddress(event.target.value);
      }} placeholder="Choose a pin, then review or enter its address" /></label>
      {resolving && <p role="status" aria-live="polite">Resolving selected address…</p>}
      {error && <div className="form-error" role="alert">{error} <button type="button" className="text-link" disabled={resolving || !coordinates} onClick={() => resolve(point.current)}>Retry address lookup</button></div>}
      <p className="location-picker-note">Editing this address keeps the exact selected pin.</p>
      <div className="location-picker-actions"><button type="button" ref={cancel} className="save-button" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!coordinates || !address.trim() || resolving} onClick={() => onConfirm({ address: address.trim(), coordinates: { ...coordinates } })}>Confirm Location</button></div>
    </section>
  </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

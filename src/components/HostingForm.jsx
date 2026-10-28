import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { ownerListingTypes } from '../data/ownerPolicy';
import { useCallback, useEffect, useRef, useState } from 'react';
import MapLocationPicker from './MapLocationPicker';
import LocationPinIcon from './LocationPinIcon';
import './DeliveryPricing.css';
import { hostingValues, validateHosting, validateHostingLocation, propertyCategories, vehicleCategories, furnishings, fuels, transmissions, hostingChoiceOptions, hostingChoiceKey, addHostingChoice } from '../data/hosting';
import './HostingForm.css';

export function HostingFields({ form, setForm, editing = false, allowedTypes = ['property', 'vehicle'] }) {
  const [customChoice, setCustomChoice] = useState(''), [choiceError, setChoiceError] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const closeMap = useCallback(() => setMapOpen(false), []);
  const property = form.type === 'property';
  const change = (key, value) => setForm({ ...form, [key]: value, ...(key === 'location' ? { locationCoordinates: null } : {}) });
  const input = (key, label, props = {}) => <label>{label}<input required value={form[key]} onChange={e => change(key, e.target.value)} {...props} /></label>;
  const select = (key, label, options) => <label>{label}<select required value={form[key]} onChange={e => change(key, e.target.value)}><option value="">Choose…</option>{[...new Set([...options, ...(form[key] && !options.includes(form[key]) ? [form[key]] : [])])].map(x => <option key={x}>{x}</option>)}</select></label>;
  const choices = property ? 'amenities' : 'features';
  const options = hostingChoiceOptions(form);
  const selected = form[choices];
  const customSelected = selected.filter((value, index) => !options.some(option => hostingChoiceKey(option) === hostingChoiceKey(value)) && selected.findIndex(x => hostingChoiceKey(x) === hostingChoiceKey(value)) === index);
  const addChoice = value => {
    try { change(choices, addHostingChoice(selected, value)); setCustomChoice(''); setChoiceError(''); }
    catch (error) { setChoiceError(error.message); }
  };
  return <>
    <div className="hosting-fields">
      <label>Listing Type<select disabled={editing} value={form.type} onChange={e => setForm(hostingValues({ type: e.target.value }))}>{allowedTypes.includes('property') && <option value="property">Room / Property</option>}{allowedTypes.includes('vehicle') && <option value="vehicle">Car / Bike / Vehicle</option>}</select></label>
      {!property && <label>Vehicle type<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value, category: e.target.value })}><option>Car</option><option>Bike</option></select></label>}
      {select('category', property ? 'Property category' : 'Vehicle category', property ? propertyCategories : vehicleCategories[form.kind])}
      {input('title', property ? 'Property title' : 'Vehicle name', { maxLength: 500 })}
      <div>{input('location', 'Complete location/address', { maxLength: 500 })}<div className="hosting-map-location"><button type="button" className="save-button" onClick={() => setMapOpen(true)}><LocationPinIcon />Choose Location on Map</button>{form.locationCoordinates && <small>Map pin selected</small>}</div></div>
      {input('price', property ? 'Monthly rent (₹)' : 'Daily rental price (₹)', { type: 'number', min: 0, max: 1e9, step: '.01' })}
      {input('phone', 'Owner contact number', { type: 'tel', pattern: '(\\+91\\s?)?[6-9][0-9]{9}', placeholder: '10-digit Indian mobile number' })}
      {property ? <>
        {input('area', 'Home size (sq.ft)', { type: 'number', min: 1, max: 1e9, step: '.01' })}
        {input('bhk', 'BHK/layout (0 = Studio)', { type: 'number', min: 0, max: 50, step: 1 })}
        {select('furnishing', 'Furnishing', furnishings)}{input('floor', 'Floor', { placeholder: 'e.g. Ground floor or 3rd floor' })}
      </> : <>{select('fuel', 'Fuel type', fuels)}{select('transmission', 'Transmission', transmissions)}{input('seats', 'Seating capacity', { type: 'number', min: 1, max: 60, step: 1 })}</>}
    </div>
    <fieldset className="hosting-options"><legend>{property ? 'Amenities' : 'Vehicle features'}</legend>{options.map(option => <label key={option}><input type="checkbox" checked={selected.some(value => hostingChoiceKey(value) === hostingChoiceKey(option))} onChange={e => e.target.checked ? addChoice(option) : change(choices, selected.filter(value => hostingChoiceKey(value) !== hostingChoiceKey(option)))} />{option}</label>)}</fieldset>
    <div className="hosting-custom-row"><label>Add custom {property ? 'amenity' : 'feature'}<input value={customChoice} maxLength={100} placeholder={property ? 'e.g. Rooftop access' : 'e.g. Rear camera'} onChange={e => setCustomChoice(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChoice(customChoice); } }} /></label><button className="save-button" type="button" onClick={() => addChoice(customChoice)}>Add</button></div>
    {choiceError && <p className="form-error" role="alert">{choiceError}</p>}
    <div className="hosting-choice-chips">{customSelected.map(value => <button type="button" className="hosting-choice-chip" key={hostingChoiceKey(value)} aria-label={`Remove ${property ? 'amenity' : 'feature'} ${value}`} onClick={() => change(choices, selected.filter(x => hostingChoiceKey(x) !== hostingChoiceKey(value)))}>{value}<span aria-hidden="true">×</span></button>)}</div>
    <label className="hosting-description">Detailed description<textarea required rows="4" maxLength={10000} value={form.description} onChange={e => change('description', e.target.value)} /></label>
    {mapOpen && <MapLocationPicker initialCoordinates={form.locationCoordinates} initialAddress={form.location} onClose={closeMap} onConfirm={({ address, coordinates }) => { setForm({ ...form, location: address, locationCoordinates: coordinates }); closeMap(); }} />}
  </>;
}

export default function HostingForm({ item, token, onSaved, onBusyChange }) {
  const { account, user } = useContext(AuthContext) || {};
  const actor = account || user;
  const allowedTypes = actor?.role === 'owner' && actor.ownerProfile?.status === 'approved' ? ownerListingTypes(actor.ownerProfile) : actor?.role === 'admin' || !actor ? ['property', 'vehicle'] : [];
  const [form, setForm] = useState(() => hostingValues(item || { type: allowedTypes[0] }));
  const [retained, setRetained] = useState(() => [...new Set([item?.image, ...(item?.gallery || [])].filter(Boolean))]);
  const [uploads, setUploads] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const fileInput = useRef();
  const submitLock = useRef(false);
  const previewUrls = useRef([]);
  useEffect(() => () => previewUrls.current.forEach(url => URL.revokeObjectURL(url)), []);
  const submit = async e => {
    e.preventDefault(); if (submitLock.current) return;
    submitLock.current = true; setError(''); setSuccess('');
    try {
      if (!allowedTypes.includes(form.type)) throw new Error('Your approved category does not allow this listing type.');
      const values = validateHosting(form);
      setBusy(true); onBusyChange?.(true);
      await validateHostingLocation(values, item, token);
      if (retained.length + uploads.length < 1 || retained.length + uploads.length > 10) throw new Error('Choose between 1 and 10 images.');
      const body = new FormData();
      for (const [key, value] of Object.entries({ ...values, ...(item ? { gallery: retained } : { type: form.type }) })) body.append(key, Array.isArray(value) || key === 'locationCoordinates' ? JSON.stringify(value) : String(value));
      uploads.forEach(x => body.append('images', x.file));
      const res = await fetch(`/api/listings${item ? '/' + item._id : ''}`, { method: item ? 'PUT' : 'POST', headers: { Authorization: `Bearer ${token}` }, body });
      const data = await res.json(); if (!res.ok) throw new Error(data.message || 'Unable to save listing.');
      if (!item) { setForm(hostingValues({ type: allowedTypes[0] })); setUploads([]); setRetained([]); if (fileInput.current) fileInput.current.value = ''; }
      setSuccess(item ? 'Listing updated successfully.' : 'Product published successfully.'); await onSaved?.(data);
    } catch (err) { setError(err.message || 'Unable to save listing. Please try again.'); }
    finally { submitLock.current = false; setBusy(false); onBusyChange?.(false); }
  };
  if (!allowedTypes.length || (item && !allowedTypes.includes(item.type))) return <p className="form-error" role="alert">Your approved hosting category is missing or does not allow this listing type. Please contact the administrator.</p>;
  return <form className="hosting-form" onSubmit={submit}>
    <fieldset disabled={busy} className="hosting-body"><p className="hosting-subheading">{form.type === 'property' ? 'Property details' : 'Vehicle details'}</p><HostingFields allowedTypes={allowedTypes} form={form} setForm={setForm} editing={Boolean(item)} />
      <label className="hosting-description hosting-upload">{item ? 'Add images' : 'Upload product images'}<small>1–10 total, up to 5 MB each · Preview and remove selections below</small><input ref={fileInput} type="file" accept="image/*" multiple onChange={e => {
        const selected = Array.from(e.target.files || []);
        if (selected.some(file => !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) || selected.length + uploads.length + retained.length > 10) { setError('Choose image files up to 5 MB each, with at most 10 images in total.'); e.target.value = ''; return; }
        const additions = selected.map(file => { const url = URL.createObjectURL(file); previewUrls.current.push(url); return { file, url }; });
        setError(''); setUploads(prev => [...prev, ...additions]); e.target.value = '';
      }} /></label>
      <div className="hosting-images">{retained.map((url, i) => <div key={url}><img src={url} alt={`Existing image ${i + 1}`} /><button type="button" aria-label={`Remove existing image ${i + 1}`} onClick={() => setRetained(retained.filter(x => x !== url))}>×</button></div>)}{uploads.map((entry, i) => <div key={entry.url}><img src={entry.url} alt={`Selected image ${i + 1}`} /><button type="button" aria-label={`Remove selected image ${i + 1}`} onClick={() => setUploads(uploads.filter(x => x !== entry))}>×</button></div>)}</div>
      {error && <p className="form-error" role="alert">{error}</p>}{success && <p style={{ color: 'var(--green)' }} role="status">{success}</p>}
      <button className="btn btn-primary hosting-publish" disabled={busy}>{busy ? 'Saving…' : item ? 'Save changes' : 'Publish Product →'}</button>
    </fieldset>
  </form>;
}

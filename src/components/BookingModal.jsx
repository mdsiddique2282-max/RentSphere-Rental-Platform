import { sampleNotice, isIsolatedPreview } from '../data/catalog';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import MapLocationPicker from './MapLocationPicker';
import { formatPrice } from '../data/listings';
import { AuthContext } from '../context/AuthContext';
import { requestToday, validateRequest, saveRequest, reserveWhatsapp, showWhatsapp, useRequestDraft, appendRequestLink } from '../data/requests';
import { vehicleBookingMessage } from '../data/vehicleBookingMessage';
import { whatsappRecipient, isSampleRequest } from '../data/whatsappRecipient';
import { isListingUnavailable } from '../data/detailHeader';
import VehicleCalendar from './VehicleCalendar';
import LocationPinIcon from './LocationPinIcon';
import DeliveryPricing from './DeliveryPricing';
import useDeliveryQuote from '../data/useDeliveryQuote';
import { pickupLocationUrl } from '../data/vehicleBookingDetails';

const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY;

export default function BookingModal({ item, mode, onClose }) {
  const { user } = useContext(AuthContext);
  const { form, setForm, coordinates: addressCoords, setCoordinates: setAddressCoords, done, setDone, close } = useRequestDraft({
    user, item, kind: 'vehicle', initialForm: { name: '', email: '', phone: '', start: '', end: '', fulfilment: 'pickup', address: '' }, onClose });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);

  // --- Geoapify address autocomplete state ---
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const closeMap = useCallback(() => setMapOpen(false), []);
  const suggestTimer = useRef(null);
  const suggestAbortRef = useRef(null);
  const blurTimer = useRef(null);

  useEffect(() => {
    const key = e => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = prevOverflow;
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
      if (blurTimer.current) clearTimeout(blurTimer.current);
      if (suggestAbortRef.current) suggestAbortRef.current.abort();
    };
  }, [close]);

  const update = e => setForm({ ...form, [e.target.name]: e.target.value });
  const chooseFulfilment = value => setForm({ ...form, fulfilment: value });

  const isVehicle = mode === 'vehicle';
  const isDelivery = isVehicle && form.fulfilment === 'delivery';

  const quoteState = useDeliveryQuote({ user, item, form, coordinates: addressCoords, active: isDelivery });
  const reviewedQuote = quoteState.quote;
  const deliveryCharge = isDelivery ? reviewedQuote?.deliveryCharge || 0 : 0;

  const rentalDays = isVehicle && form.start && form.end
    ? Math.max(1, Math.round((new Date(form.end) - new Date(form.start)) / 86400000))
    : 0;
  const rentalCost = isDelivery && reviewedQuote ? reviewedQuote.rentalAmount : rentalDays * (item.price || 0);
  const rentalRate = isDelivery && reviewedQuote ? reviewedQuote.rentalAmount / rentalDays : item.price;
  const estimatedTotal = isDelivery ? reviewedQuote?.totalPrice ?? rentalCost : rentalCost;

  const [whatsappUrl, setWhatsappUrl] = useState('');
  const openWhatsapp = () => { if (whatsappUrl) window.open(whatsappUrl, '_blank', 'noopener,noreferrer'); };

  // --- Address input: typing manually always clears any previously selected coordinates ---
  const updateAddress = e => {
    const value = e.target.value;
    setForm(f => ({ ...f, address: value }));
    setAddressCoords(null);

    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (suggestAbortRef.current) suggestAbortRef.current.abort();

    if (value.trim().length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    suggestTimer.current = setTimeout(async () => {
      const controller = new AbortController();
      suggestAbortRef.current = controller;
      try {
        const res = await fetch(
          `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(value)}&filter=countrycode:in&limit=10&apiKey=${GEOAPIFY_API_KEY}`,
          { signal: controller.signal }
        );
        const data = await res.json();
        setSuggestions(data.features || []);
        setShowSuggestions(true);
      } catch (err) {
        if (err.name !== 'AbortError') setSuggestions([]);
      }
    }, 350);
  };

  const selectSuggestion = feature => {
    const props = feature.properties || {};
    setForm(f => ({ ...f, address: props.formatted || f.address }));
    setAddressCoords({ lat: props.lat, lon: props.lon });
    setSuggestions([]);
    setShowSuggestions(false);
    setError('');
  };

  const handleAddressBlur = () => {
    // small delay so a click on a suggestion registers before the list hides
    blurTimer.current = setTimeout(() => setShowSuggestions(false), 150);
  };

    const submit = async e => {
  e.preventDefault();
  if (submissionLock.current || done) return;
  if (isIsolatedPreview(item) && isListingUnavailable(item)) return setError('This vehicle is unavailable for new bookings.');

  if (!form.name || !form.email || !form.phone || !form.start) {
    return setError('Please complete the required fields.');
  }

  if (isVehicle && !form.end) {
    return setError('Choose a return date.');
  }

  if (isDelivery) {
    if (!form.address.trim()) {
      return setError('Enter a delivery address.');
    }
    if (!reviewedQuote?.quoteId || Date.parse(reviewedQuote.expiresAt) <= Date.now()) return setError('Calculate and review a current delivery quote before submitting.');

  }

  let whatsappPopup;
  let savedVehicle = false;
  try {
    setError('');
    const listingId = isIsolatedPreview(item) ? item._id || item.id : item.id || item._id;
    validateRequest({ user, listingId, startDate: form.start, endDate: form.end || form.start });
    const recipient = isVehicle ? whatsappRecipient(item) : '919403570134';
    submissionLock.current = true;
    setSubmitting(true);
    if (isVehicle) whatsappPopup = reserveWhatsapp();
    if (isVehicle) {
      const availabilityResponse = await fetch(`/api/listings/${listingId}/availability?from=${form.start}&to=${form.end}`);
      const availability = await availabilityResponse.json();
      if (!availabilityResponse.ok || !availability.available || availability.bookedRanges?.length) throw new Error(availability.message || 'These dates are unavailable. Please choose another range.');
    }
    const request = await saveRequest({
      user, listingId, startDate: form.start, endDate: form.end || form.start,
      fulfilment: isDelivery ? 'delivery' : 'pickup',
      deliveryAddress: isDelivery ? form.address : undefined,
      ...(isDelivery && addressCoords ? { deliveryCoordinates: addressCoords } : {}),
      ...(isDelivery ? { deliveryQuoteId: reviewedQuote.quoteId } : {}),
      contact: { name: form.name, email: form.email, phone: form.phone },
    });
    if (isVehicle) { savedVehicle = true; setDone(true); }

    const bookingType = mode === 'property' ? 'Property' : item.kind || 'Vehicle';

    const bookingDetails = mode === 'property'
      ? `Date: ${form.start}`
      : `Pickup Date: ${form.start}\nReturn Date: ${form.end}`;

    const fulfilmentDetails = isVehicle
      ? `\nFulfilment: ${isDelivery ? 'Home Delivery' : 'Self Pickup'}${isDelivery ? '' : ' (Free)'}${isDelivery ? `\nDelivery Address: ${form.address}\nDelivery Charge: ₹${formatPrice(deliveryCharge)}` : ''}`
      : '';

    const totalLine = isVehicle && rentalCost > 0
      ? `\nEstimated Total: ₹${formatPrice(estimatedTotal)} (${rentalDays} day${rentalDays > 1 ? 's' : ''} x ₹${formatPrice(item.price)}${deliveryCharge ? ` + ₹${formatPrice(deliveryCharge)} delivery` : ''})`
      : '';

    const message = isVehicle
      ? vehicleBookingMessage({ booking: request })
      : `${isSampleRequest(item) ? sampleNotice(item) : ''}RentSphere - ${bookingType} Booking Request\nRequest ID: ${request.requestId}\n\n${mode === 'property' ? 'Property' : 'Vehicle'}: ${item.title || item.name}\n${mode === 'vehicle' ? `Type: ${item.kind || item.type}\n` : ''}Location: ${item.location}\n\nCustomer Details:\nName: ${form.name}\nPhone: ${form.phone}\nEmail: ${form.email}\n\n${mode === 'property' ? 'Booking' : 'Rental'} Details:\n${bookingDetails}${fulfilmentDetails}${totalLine}\n\nPlease confirm this ${mode === 'property' ? 'booking' : 'rental'}.`;

    const url = `https://wa.me/${recipient}?text=${encodeURIComponent(appendRequestLink(message, request))}`;

setWhatsappUrl(url);
setDone(true);
if (isVehicle) showWhatsapp(whatsappPopup, url);

  } catch (error) {
    whatsappPopup?.close();
    if (isDelivery && !savedVehicle) quoteState.invalidate();
    console.error('Booking error:', error);
    setError(savedVehicle ? 'Your booking was saved, but WhatsApp could not be opened. Review the request in your Dashboard.' : error.message || 'Unable to create booking. Please try again.');
  } finally {
    submissionLock.current = false;
    setSubmitting(false);
  }
};

    const bookingDisabled = submitting || (isDelivery && (!form.address.trim() || !reviewedQuote || quoteState.loading || Date.parse(reviewedQuote.expiresAt) <= Date.now()));

    return (
      <div className="modal-backdrop" role="presentation" onMouseDown={close}>
        <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-heading" onMouseDown={e => e.stopPropagation()}>
          {done ? (
            <div className="booking-success">
              <div className="success-mark">✓</div>
              {isVehicle ? <>
                <h2>Booking request submitted!</h2>
                <p>Your vehicle booking request has been successfully sent to the owner and is currently Pending. Once the owner accepts your request, you can contact them on WhatsApp to discuss pickup, delivery, and other booking details.</p>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="btn btn-primary full" onClick={close}>Done</button>
              </> : <>
                <h2>WhatsApp is ready</h2>
                <p>Your booking request is saved as Pending. Click the button below to open WhatsApp with your pre-filled message and contact the owner.</p>
                <button className="btn btn-primary full" onClick={openWhatsapp}>Open WhatsApp →</button>
                <button className="text-link" onClick={close}>Done</button>
              </>}
            </div>
          ) : (
            <>
              <button className="modal-close" aria-label="Close booking" onClick={close}>×</button>
              <span className="eyebrow">Booking request · step 1 of 1</span>
              <h2 id="booking-heading">Reserve {item.title || item.name}</h2>
              <p className="modal-subtitle">Share your details and we’ll prepare a WhatsApp booking request for you to send.</p>
              {isVehicle && <VehicleCalendar item={item} startDate={form.start} endDate={form.end} onChange={dates => setForm(previous => ({ ...previous, ...dates }))} />}
              <form onSubmit={submit} noValidate>
                <div className="form-grid">
                  <label>Full name
                    <input name="name" value={form.name} onChange={update} placeholder="Your name" />
                  </label>
                  <label>Email
                    <input name="email" type="email" value={form.email} onChange={update} placeholder="you@example.com" />
                  </label>
                  <label>Phone
                    <input name="phone" value={form.phone} onChange={update} placeholder="10-digit mobile number" />
                  </label>
                  {!isVehicle && <label>Move-in date
                    <input name="start" type="date" min={requestToday()} value={form.start} onChange={update} />
                  </label>}
                </div>

                {isVehicle && (
                  <div className="fulfilment-block">
                    <span className="fulfilment-label">How would you like the vehicle?</span>
                    <div className="toggle fulfilment-toggle">
                      <button type="button" className={form.fulfilment === 'pickup' ? 'active' : ''} onClick={() => chooseFulfilment('pickup')}>
                        Self pickup
                      </button>
                      <button type="button" className={form.fulfilment === 'delivery' ? 'active' : ''} onClick={() => chooseFulfilment('delivery')}>
                        Home delivery
                      </button>
                    </div>
                  <p className="fulfilment-note">
                    {isDelivery
                      ? 'Home Delivery is limited to the configured RentSphere Delivery Service Area. Calculate and review the road-based charge below.'
                      : 'Self pickup is free — collect the vehicle from the listed location.'}
                  </p>
                  {!isDelivery && <p className="fulfilment-note"><strong>Pickup Address:</strong> {item.location || 'Pickup address not recorded.'}
                    {pickupLocationUrl(item.locationCoordinates) && <> · <a className="text-link" href={pickupLocationUrl(item.locationCoordinates)} target="_blank" rel="noopener noreferrer">View Pickup Location</a></>}
                  </p>}
                  {isDelivery && (
                    <>
                      <label className="full address-autocomplete delivery-address-field"><span>Delivery Address</span>
                        <input
                          name="address"
                          value={form.address}
                          onChange={updateAddress}
                          onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                          onBlur={handleAddressBlur}
                          placeholder="Enter your full address here"
                          autoComplete="off"
                        />
                        {showSuggestions && suggestions.length > 0 && (
                          <ul className="address-suggestions">
                            {suggestions.map(feature => (
                              <li key={feature.properties.place_id || feature.properties.formatted}>
                                <button type="button" onClick={() => selectSuggestion(feature)}>
                                  {feature.properties.formatted}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </label>
                      <button type="button" className="save-button delivery-map-location" onClick={() => {
                        if (suggestTimer.current) clearTimeout(suggestTimer.current);
                        suggestAbortRef.current?.abort(); setSuggestions([]); setShowSuggestions(false); setMapOpen(true);
                      }}><LocationPinIcon />Choose Delivery Location on Map</button>
                      {addressCoords && <small className="delivery-location-indicator">Delivery location selected: {addressCoords.lat}, {addressCoords.lon}</small>}
                      {mapOpen && <MapLocationPicker initialCoordinates={addressCoords} initialAddress={form.address} onClose={closeMap} onConfirm={({ address, coordinates }) => {
                        setForm(previous => ({ ...previous, address })); setAddressCoords(coordinates); setSuggestions([]); setShowSuggestions(false); closeMap();
                      }} />}
                      <DeliveryPricing state={quoteState} item={item} coordinates={addressCoords} form={form} loggedIn={Boolean(user?.token)} />
                    </>
                  )}
                  {rentalCost > 0 && (!isDelivery || reviewedQuote) && (
                    <div className="fulfilment-summary">
                      <span>{rentalDays} day{rentalDays > 1 ? 's' : ''} x ₹{formatPrice(rentalRate)}</span>
                      <span>₹{formatPrice(rentalCost)}</span>
                      <span>Delivery charge</span>
                      <span>{isDelivery ? `₹${formatPrice(deliveryCharge)}` : 'Free'}</span>
                      <strong>Estimated total</strong>
                      <strong>₹{formatPrice(estimatedTotal)}</strong>
                    </div>
                  )}
                </div>
              )}

              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn btn-primary full" type="submit" disabled={bookingDisabled}>Continue to WhatsApp →</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

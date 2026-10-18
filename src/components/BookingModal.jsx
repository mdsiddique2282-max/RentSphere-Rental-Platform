import { useContext, useEffect, useRef, useState } from 'react';
import { formatPrice } from '../data/listings';
import { AuthContext } from '../context/AuthContext';

const DELIVERY_FEE = 300;
const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY;

export default function BookingModal({ item, mode, onClose }) {
  const { user } = useContext(AuthContext);
  const [form, setForm] = useState({ name: '', email: '', phone: '', start: '', end: '', fulfilment: 'pickup', address: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // --- Geoapify address autocomplete state ---
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [addressCoords, setAddressCoords] = useState(null); // { lat, lon } of the SELECTED suggestion only
  const suggestTimer = useRef(null);
  const suggestAbortRef = useRef(null);
  const blurTimer = useRef(null);

  useEffect(() => {
    const key = e => e.key === 'Escape' && onClose();
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
  }, [onClose]);

  const update = e => setForm({ ...form, [e.target.name]: e.target.value });
  const chooseFulfilment = value => setForm({ ...form, fulfilment: value });

  const isVehicle = mode === 'vehicle';
  const isDelivery = isVehicle && form.fulfilment === 'delivery';

  const deliveryCharge = isDelivery ? DELIVERY_FEE : 0;

  const rentalDays = isVehicle && form.start && form.end
    ? Math.max(1, Math.round((new Date(form.end) - new Date(form.start)) / 86400000))
    : 0;
  const rentalCost = rentalDays * (item.price || 0);
  const estimatedTotal = isDelivery ? rentalCost + deliveryCharge : rentalCost;

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
          `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(value)}&filter=countrycode:in&limit=5&apiKey=${GEOAPIFY_API_KEY}`,
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

    if (!addressCoords) {
      return setError('Please select a delivery address from the suggestions.');
    }
  }

  try {
    setError('');

    // Only listings stored in MongoDB have a real id (24-char hex). Built-in sample listings
    // (e.g. "V101") have no database record, so no booking record is created for them - the
    // WhatsApp request below still works exactly as before.
    const isDatabaseListing = /^[0-9a-fA-F]{24}$/.test(String(item.id || ''));

    if (isDatabaseListing) {
      if (!user || !user.token) {
        return setError('Please log in to complete your booking.');
      }

      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          listingId: item.id,
          startDate: form.start,
          endDate: form.end || form.start,
          fulfilment: isDelivery ? 'delivery' : 'pickup',
          deliveryAddress: isDelivery ? form.address : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Booking failed. Please try again.');
      }
    }

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

    const message = `RentSphere - ${bookingType} Booking Request\n\n${mode === 'property' ? 'Property' : 'Vehicle'}: ${item.title || item.name}\n${mode === 'vehicle' ? `Type: ${item.kind || item.type}\n` : ''}Location: ${item.location}\n\nCustomer Details:\nName: ${form.name}\nPhone: ${form.phone}\nEmail: ${form.email}\n\n${mode === 'property' ? 'Booking' : 'Rental'} Details:\n${bookingDetails}${fulfilmentDetails}${totalLine}\n\nPlease confirm this ${mode === 'property' ? 'booking' : 'rental'}.`;

    const url = `https://wa.me/919403570134?text=${encodeURIComponent(message)}`;

    setWhatsappUrl(url);
    setDone(true);
    window.open(url, '_blank', 'noopener,noreferrer');

  } catch (error) {
    console.error('Booking error:', error);
    setError(error.message || 'Unable to create booking. Please try again.');
  }
};

    const bookingDisabled = isDelivery && !addressCoords;

    return (
      <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
        <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-heading" onMouseDown={e => e.stopPropagation()}>
          {done ? (
            <div className="booking-success">
              <div className="success-mark">✓</div>
              <h2>WhatsApp is ready</h2>
              <p>We opened WhatsApp in a new tab with your booking details pre-filled. If it landed on your chats list instead of the message directly, you're likely not logged into WhatsApp Web — log in (or open the WhatsApp app on your phone) and tap the button below again to jump straight to the pre-filled chat.</p>
              <button className="btn btn-primary full" onClick={openWhatsapp}>Open WhatsApp again →</button>
              <button className="text-link" onClick={onClose}>Done</button>
            </div>
          ) : (
            <>
              <button className="modal-close" aria-label="Close booking" onClick={onClose}>×</button>
              <span className="eyebrow">Booking request · step 1 of 1</span>
              <h2 id="booking-heading">Reserve {item.title || item.name}</h2>
              <p className="modal-subtitle">Share your details and we’ll prepare a WhatsApp booking request for you to send.</p>
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
                  <label>{mode === 'vehicle' ? 'Pickup date' : 'Move-in date'}
                    <input name="start" type="date" value={form.start} onChange={update} />
                  </label>
                  {isVehicle && (
                    <label>Return date
                      <input name="end" type="date" value={form.end} min={form.start} onChange={update} />
                    </label>
                  )}
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
                      ? `Home delivery charge is ₹${DELIVERY_FEE} within Mumbai.`
                      : 'Self pickup is free — collect the vehicle from the listed location.'}
                  </p>
                  {isDelivery && (
                    <>
                      <label className="full address-autocomplete">Delivery address
                        <input
                          name="address"
                          value={form.address}
                          onChange={updateAddress}
                          onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                          onBlur={handleAddressBlur}
                          placeholder="Start typing your address..."
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

                      {isDelivery && (
                        <p className="distance-info">
                          Delivery charge: ₹{formatPrice(deliveryCharge)}
                        </p>
                      )}
                    </>
                  )}
                  {rentalCost > 0 && (
                    <div className="fulfilment-summary">
                      <span>{rentalDays} day{rentalDays > 1 ? 's' : ''} x ₹{formatPrice(item.price)}</span>
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

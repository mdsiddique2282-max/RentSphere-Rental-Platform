import { useEffect, useState } from 'react';

// "Request a Visit" flow for PROPERTIES only.
// Vehicles never use this component; they keep the existing BookingModal flow.
export default function PropertyVisitModal({ item, onClose, onVisitRequested }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', start: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const key = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const update = e => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = e => {
    e.preventDefault();
    if (!form.name || !form.email || !form.phone || !form.start) {
      return setError('Please complete the required fields.');
    }
    setError('');

    const visits = JSON.parse(localStorage.getItem('rentsphere-bookings') || '[]');
    localStorage.setItem('rentsphere-bookings', JSON.stringify([
      ...visits,
      { item: item.id, mode: 'property', ...form, createdAt: new Date().toISOString() }
    ]));

    const message = `RentSphere - Property Visit Request\n\nProperty: ${item.title || item.name}\nLocation: ${item.location}\n\nCustomer Details:\nName: ${form.name}\nPhone: ${form.phone}\nEmail: ${form.email}\n\nVisit Date: ${form.start}\n\nPlease confirm this visit request.`;

    setDone(true);
    onVisitRequested?.();
    window.open(`https://wa.me/919403570134?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="visit-heading" onMouseDown={e => e.stopPropagation()}>
        {done ? (
          <div className="booking-success">
            <div className="success-mark">✓</div>
            <h2>Visit request sent</h2>
<p>
  Your property visit request is ready on WhatsApp. Please send the message to the owner to confirm your visit.
  After visiting the property, return to RentSphere and select
  <strong> Interested </strong> or <strong> Not Interested </strong>
  to share your decision with the property owner.
</p>            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <button className="modal-close" aria-label="Close visit request" onClick={onClose}>×</button>
            <span className="eyebrow">Visit request · step 1 of 1</span>
            <h2 id="visit-heading">Request a visit for {item.title || item.name}</h2>
            <p className="modal-subtitle">Share your details and we’ll prepare a WhatsApp visit request for you to send.</p>
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
                <label>Visit date
                  <input name="start" type="date" value={form.start} onChange={update} />
                </label>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn btn-primary full" type="submit">Continue to WhatsApp →</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

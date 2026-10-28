import { isIsolatedPreview } from '../data/catalog';
import { whatsappRecipient } from '../data/whatsappRecipient';
import { useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { isListingUnavailable } from '../data/detailHeader';
import { requestToday, validateRequest, saveRequest, reserveWhatsapp, showWhatsapp, previewVisitMessage, useRequestDraft, appendRequestLink } from '../data/requests';

// "Request a Visit" flow for PROPERTIES only.
// Vehicles never use this component; they keep the existing BookingModal flow.
export default function PropertyVisitModal({ item, onClose, onVisitRequested }) {
  const { user } = useContext(AuthContext);
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);
  const { form, setForm, done, setDone, close } = useRequestDraft({ user, item, kind: 'property_visit',
    initialForm: { name: '', email: '', phone: '', start: '' }, onClose });
  const [error, setError] = useState('');

  useEffect(() => {
    const key = e => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);

  const update = e => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async e => {
    e.preventDefault();
    if (submissionLock.current || done) return;
    if (isIsolatedPreview(item) && isListingUnavailable(item)) return setError('This property is unavailable for new visits.');
    if (!form.name || !form.email || !form.phone || !form.start) {
      return setError('Please complete the required fields.');
    }
    let whatsappPopup;
    try {
      setError('');
      const listingId = isIsolatedPreview(item) ? item._id || item.id : item.id || item._id;
      validateRequest({ user, listingId, startDate: form.start, endDate: form.start });
      const recipient = whatsappRecipient(item);
      submissionLock.current = true;
      setSubmitting(true);
      whatsappPopup = reserveWhatsapp();
      const request = await saveRequest({
        user, isVisit: true, listingId, startDate: form.start,
        contact: { name: form.name, email: form.email, phone: form.phone },
      });

      const message = appendRequestLink(previewVisitMessage(item, form), request);

      setDone(true);
      onVisitRequested?.(request);
      showWhatsapp(whatsappPopup, `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`);
    } catch (error) {
      whatsappPopup?.close();
      setError(error.message || 'Unable to save your visit request. Please try again.');
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="visit-heading" onMouseDown={e => e.stopPropagation()}>
        {done ? (
          <div className="booking-success">
            <div className="success-mark">✓</div>
            <h2>Visit request saved</h2>
<p>
  Your property visit request is saved as Pending. Please send the WhatsApp message to the owner to arrange your visit.
  After visiting the property, return to RentSphere and select
  <strong> Interested </strong> or <strong> Not Interested </strong>
  to share your decision with the property owner.
</p>            <button className="btn btn-primary" onClick={close}>Done</button>
          </div>
        ) : (
          <>
            <button className="modal-close" aria-label="Close visit request" onClick={close}>×</button>
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
                  <input name="start" type="date" min={requestToday()} value={form.start} onChange={update} />
                </label>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn btn-primary full" type="submit" disabled={submitting}>Continue to WhatsApp →</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

import { useEffect, useId, useRef } from 'react';

export default function HistoryConfirmation({ titleText, descriptionText, confirmText, release, bulk = false, removing, ownerHistory = false, busy, error, onClose, onConfirm }) {
  const dialog = useRef(), cancelButton = useRef(), busyRef = useRef(busy);
  busyRef.current = busy;
  const title = useId(), description = useId();
  useEffect(() => {
    const trigger = document.activeElement;
    const fallback = trigger?.closest('.dashboard-requests, .owner-request-section, .vehicle-calendar')?.querySelector('h2');
    cancelButton.current?.focus();
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
    return () => { document.removeEventListener('keydown', keyboard); if (trigger?.isConnected) trigger.focus(); else if (fallback?.isConnected) fallback.focus(); };
  }, [onClose]);
  return <div className="delete-modal-overlay"><section ref={dialog} tabIndex={-1} className="delete-modal history-confirmation" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={description} aria-busy={busy}>
    <h2 id={title}>{titleText || (release ? 'Make Dates Available?' : bulk ? 'Delete All Requests?' : removing ? 'Remove from history?' : 'Cancel this request?')}</h2>
    <p id={description}>{descriptionText || (release ? 'Cancel this booking and make its reserved dates available for new customers?' : bulk ? 'These requests will be removed from your dashboard. Existing booking records will remain unchanged.' : removing ? ownerHistory ? 'This request will be hidden from your Owner Dashboard. It will remain available to the customer and administrator.' : 'This request will be hidden from your dashboard. It will remain available to the owner and administrator. Its status and reserved dates will not change.' : 'Your request will remain in your history.')}</p>
    {release && <p><strong>{release.startDate?.slice(0, 10)} – {release.endDate?.slice(0, 10)}</strong></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="delete-modal-actions"><button ref={cancelButton} disabled={busy} onClick={onClose}>{release || bulk || removing ? 'Cancel' : 'Keep request'}</button><button disabled={busy} onClick={onConfirm}>{busy ? release ? 'Updating…' : bulk || removing ? 'Removing…' : 'Cancelling…' : confirmText || (release ? 'Make Available' : bulk ? 'Delete All' : removing ? 'Remove' : 'Confirm cancellation')}</button></div>
  </section></div>;
}

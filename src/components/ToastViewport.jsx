import { useSyncExternalStore } from 'react';
import { toastStore } from '../data/toasts';
import './ToastViewport.css';

export default function ToastViewport() {
  const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
  return <div className="toast-viewport" aria-label="Notifications">
    {toast && <div className={`toast toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} aria-atomic="true">
      <span className="toast-symbol" aria-hidden="true">{toast.type === 'error' ? '!' : '✓'}</span>
      <span>{toast.message}</span>
      <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={toastStore.dismiss}>×</button>
    </div>}
  </div>;
}

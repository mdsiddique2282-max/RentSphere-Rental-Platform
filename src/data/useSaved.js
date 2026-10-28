import { useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { notifyToast } from './toasts';

export function useSaved() {
  const { user } = useContext(AuthContext);
  const [saved, setSaved] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('rentsphere-saved') || '[]')); } catch { return new Set(); }
  });
  const pending = useRef(new Set());
  useEffect(() => {
    if (!user?.token) {
      try { setSaved(new Set(JSON.parse(localStorage.getItem('rentsphere-saved') || '[]'))); } catch { setSaved(new Set()); }
      return;
    }
    let active = true;
    const load = () => fetch('/api/saved', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(rows => { if (active) setSaved(new Set(rows.flatMap(row => [row._id, row.legacyId].filter(Boolean)))); })
      .catch(() => { if (active) notifyToast('Unable to load saved listings.', 'error'); });
    setSaved(new Set()); load();
    window.addEventListener('rentsphere-saved-changed', load);
    return () => { active = false; window.removeEventListener('rentsphere-saved-changed', load); };
  }, [user?.token]);
  const toggle = async id => {
    if (pending.current.has(id)) return;
    if (!user?.token) {
      setSaved(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); localStorage.setItem('rentsphere-saved', JSON.stringify([...next])); return next; });
      return;
    }
    pending.current.add(id);
    try {
      const response = await fetch(`/api/saved/${encodeURIComponent(id)}`, { method: saved.has(id) ? 'DELETE' : 'PUT', headers: { Authorization: `Bearer ${user.token}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      window.dispatchEvent(new Event('rentsphere-saved-changed'));
    } catch (error) { notifyToast(error.message || 'Unable to save listing.', 'error'); }
    finally { pending.current.delete(id); }
  };
  return [saved, toggle];
}

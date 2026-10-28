import { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { PropertyCard, VehicleCard } from './ListingCards';
import { useSaved } from '../data/useSaved';

export default function SavedListings() {
  const { user } = useContext(AuthContext);
  const [rows, setRows] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [saved, toggle] = useSaved();
  useEffect(() => {
    let active = true, sequence = 0;
    setRows([]); setLoading(true); setError('');
    const load = async () => {
      const current = ++sequence;
      try {
        const response = await fetch('/api/saved', { headers: { Authorization: `Bearer ${user.token}` } });
        const data = await response.json(); if (!response.ok) throw new Error(data.message);
        if (!Array.isArray(data)) throw new Error('Unable to load saved listings.');
        if (active && current === sequence) { setRows(data.filter(row => row?._id && ['property', 'vehicle'].includes(row.type))); setError(''); }
      } catch (e) { if (active && current === sequence) setError('Unable to load saved listings. Please try again.'); }
      finally { if (active && current === sequence) setLoading(false); }
    };
    load(); window.addEventListener('rentsphere-saved-changed', load);
    return () => { active = false; window.removeEventListener('rentsphere-saved-changed', load); };
  }, [user?.token]);
  return <section className="info-card"><h2>Saved Listings</h2>{error && <p className="form-error" role="alert">{error}</p>}{loading ? <p>Loading saved listings…</p> : !rows.length ? !error && <p>Save a property or vehicle using its heart button.</p> : <div className="cards-grid">{rows.map(row => {
    const Card = row.type === 'property' ? PropertyCard : VehicleCard;
    return <Card key={row._id} item={row} saved={saved.has(row._id)} onSave={toggle} />;
  })}</div>}</section>;
}

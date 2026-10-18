import { Link } from 'react-router-dom';
import { formatPrice } from '../data/listings';

export function PropertyCard({ item, saved, onSave }) {
  const itemId = item.id || item._id;
  const title = item.title || item.name || 'Property Rental';
  const category = item.category || item.type || 'Property';
  const availability = item.availability || 'Available';
  const image = item.image || (item.gallery && item.gallery[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=800&q=80';
  const rating = item.rating || 4.5;
  const bhk = item.bhk || 2;
  const area = item.area || 850;
  const furnishing = item.furnishing || 'Semi-furnished';

  return (
    <article className="listing-card tilt-card">
      <div className="card-media">
        <img loading="lazy" src={image} alt={title}/>
        <span className="status">{availability}</span>
        <button className={`heart ${saved ? 'saved':''}`} onClick={() => onSave(itemId)} aria-label="Save property">♥</button>
      </div>
      <div className="card-content">
        <div className="eyebrow">{category} · ★ {rating}</div>
        <h3>{title}</h3>
        <p className="location">⌖ {item.location}</p>
        <div className="facts">
          <span>{bhk} BHK</span>
          <span>{area} sq.ft</span>
          <span>{furnishing}</span>
        </div>
        <div className="card-actions">
          <div>
            <strong>₹{formatPrice(item.price)}</strong>
            <small>/ month</small>
          </div>
          <Link className="text-link" to={`/properties/${itemId}`}>View details →</Link>
        </div>
      </div>
    </article>
  );
}

export function VehicleCard({ item, saved, onSave }) {
  const itemId = item.id || item._id;
  const name = item.name || item.title || 'Vehicle Rental';
  const category = item.category || item.kind || item.type || 'Vehicle';
  const badge = item.badge || 'Available';
  const image = item.image || (item.gallery && item.gallery[0]) || 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80';
  const rating = item.rating || 4.5;
  const fuel = item.fuel || 'Petrol';
  const transmission = item.transmission || 'Manual';
  const seats = item.seats || 5;

  return (
    <article className="listing-card tilt-card">
      <div className="card-media">
        <img loading="lazy" src={image} alt={name}/>
        <span className="status">{badge}</span>
        <button className={`heart ${saved ? 'saved':''}`} onClick={() => onSave(itemId)} aria-label="Save vehicle">♥</button>
      </div>
      <div className="card-content">
        <div className="eyebrow">{category} · ★ {rating}</div>
        <h3>{name}</h3>
        <p className="location">⌖ {item.location}</p>
        <div className="facts">
          <span>{fuel}</span>
          <span>{transmission}</span>
          <span>{seats} seats</span>
        </div>
        <div className="card-actions">
          <div>
            <strong>₹{formatPrice(item.price)}</strong>
            <small>/ day</small>
          </div>
          <Link className="text-link" to={`/vehicles/${itemId}`}>View details →</Link>
        </div>
      </div>
    </article>
  );
}

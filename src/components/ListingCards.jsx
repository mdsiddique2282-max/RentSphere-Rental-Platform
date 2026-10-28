import { Link } from 'react-router-dom';
import { formatPrice } from '../data/listings';
import CatalogImage from './CatalogImage';
import { vehicleBookingDisplay } from '../data/detailHeader';
import { isSample, unavailablePhoto, isIsolatedPreview, previewAvailability, previewTitle } from '../data/catalog';

export function PropertyCard({ item, saved, onSave }) {
  const itemId = item.id || item._id;
  const title = previewTitle(item) || 'Property Rental';
  const category = item.category || item.type || 'Property';
  const availability = isIsolatedPreview(item) ? previewAvailability(item) : isSample(item) ? 'Demo / Sample' : item.availability || 'Available';
  const image = item.image || (item.gallery && item.gallery[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=800&q=80';
  const rating = item.rating > 0 ? `★ ${item.rating}` : 'Not yet rated';
  const bhk = item.bhk ?? 2;
  const area = item.area || 850;
  const furnishing = item.furnishing || 'Semi-furnished';

  return (
    <article className="listing-card tilt-card">
      <div className="card-media">
        <CatalogImage item={item} loading="lazy" src={isSample(item) ? item.image || item.gallery?.[0] || unavailablePhoto(item) : image} alt={title}/>
        <span className="status">{availability}</span>
        <button className={`heart ${saved ? 'saved':''}`} onClick={() => onSave(itemId)} aria-label="Save property">♥</button>
      </div>
      <div className="card-content">
        <div className="eyebrow">{category} · {isSample(item) ? 'Sample · unverified' : rating}</div>
        <h3>{title}</h3>
        <p className="location">⌖ {item.location}</p>
        <div className="facts">
          <span>{bhk === 0 ? 'Studio' : `${bhk} BHK`}</span>
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
  const bookingDisplay = vehicleBookingDisplay(item);
  const image = item.image || (item.gallery && item.gallery[0]) || 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80';
  const rating = item.rating > 0 ? `★ ${item.rating}` : 'Not yet rated';
  const fuel = item.fuel || 'Petrol';
  const transmission = item.transmission || 'Manual';
  const seats = item.seats || 5;

  return (
    <article className="listing-card tilt-card">
      <div className="card-media">
        <CatalogImage item={item} loading="lazy" src={isSample(item) ? item.image || item.gallery?.[0] || unavailablePhoto(item) : image} alt={name}/>
        <span className={`status vehicle-status vehicle-status--${bookingDisplay.state}`}>{bookingDisplay.label}</span>
        <button className={`heart ${saved ? 'saved':''}`} onClick={() => onSave(itemId)} aria-label="Save vehicle">♥</button>
      </div>
      <div className="card-content">
        <div className="eyebrow">{category} · {isSample(item) ? 'Sample · unverified' : rating}</div>
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

export function VehicleBookingBanner({ item, onCheckDates }) {
  if (vehicleBookingDisplay(item).state !== 'partial') return null;
  return <aside className="vehicle-booking-banner">
    <p>This vehicle is booked for certain dates.<br />You can still reserve it for other available dates!</p>
    <button type="button" onClick={onCheckDates}>Check Available Dates →</button>
  </aside>;
}

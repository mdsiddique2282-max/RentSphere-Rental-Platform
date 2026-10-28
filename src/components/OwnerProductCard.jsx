import { Link } from 'react-router-dom';
import { formatPrice } from '../data/listings';
import { isListingUnavailable } from '../data/detailHeader';
import ListingControls from './ListingControls';
import CatalogImage from './CatalogImage';

export default function OwnerProductCard({ item, canManage, onChanged, onDelete }) {
  const unavailable = isListingUnavailable(item);
  return <article className="owner-rental-card">
    <div className="owner-rental-image"><CatalogImage item={item} src={item.image || item.gallery?.[0]} alt={item.title || item.name} loading="lazy" /><span className={`owner-availability ${unavailable ? 'is-unavailable' : ''}`}>{unavailable ? 'Unavailable' : 'Available'}</span></div>
    <div className="owner-rental-content"><span className="eyebrow">{item.type} · {item.category}</span><h3>{item.title || item.name}</h3><p className="owner-rental-location">⌖ {item.location}</p><p className="owner-rental-price">₹{formatPrice(item.price)}<small> / {item.type === 'property' ? 'month' : 'day'}</small></p>
      <div className="owner-product-actions"><Link className="save-button owner-view-link" to={`/${item.type === 'property' ? 'properties' : 'vehicles'}/${item._id}`}>View Listing</Link>
        {canManage && <ListingControls item={item} allowEdit onChanged={onChanged} />}
        {canManage && <button className="save-button owner-delete" onClick={() => onDelete(item._id)}>Delete</button>}
      </div>
    </div>
  </article>;
}

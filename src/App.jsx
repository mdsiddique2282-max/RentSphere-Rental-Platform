import { useMemo, useState, useEffect } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Footer, Navbar } from './components/Layout';
import { PropertyCard, VehicleCard } from './components/ListingCards';
import BookingModal from './components/BookingModal';
import PropertyVisitModal from './components/PropertyVisitModal';
import AuthForm from './components/AuthForm';
import { AboutPage, ContactPage } from './components/InfoPages';
import { properties, vehicles, formatPrice } from './data/listings';
import { CITIES, getCity, matchesLocation, readLocationParams } from './data/locations';
import AdminPanel from './components/AdminPanel';
import UserDashboard from './components/UserDashboard';
import OwnerOnboarding from './components/OwnerOnboarding';

// Property "Request a Visit" helpers (properties only; vehicles never use these)
const PROPERTY_STATUS_KEY = 'rentsphere-property-statuses';
const PROPERTY_VISIT_KEY = 'rentsphere-property-visits';
const readStoredIds = key => {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
};
const isRentedProperty = item => item?.status === 'rented' || item?.availability === 'Currently Rented';
const applyStoredPropertyStatus = item => {
  if (!item || !readStoredIds(PROPERTY_STATUS_KEY).has(item.id || item._id)) return item;
  return { ...item, status: 'rented', availability: 'Currently Rented' };
};
const storePropertyStatus = id => {
  const statuses = readStoredIds(PROPERTY_STATUS_KEY);
  statuses.add(id);
  localStorage.setItem(PROPERTY_STATUS_KEY, JSON.stringify([...statuses]));
};

const useSaved = () => { 
  const [saved, setSaved] = useState(() => new Set(JSON.parse(localStorage.getItem('rentsphere-saved') || '[]'))); 
  const toggle = id => setSaved(old => {
    const next = new Set(old); 
    next.has(id) ? next.delete(id) : next.add(id);
    localStorage.setItem('rentsphere-saved', JSON.stringify([...next]));
    return next;
  }); 
  return [saved, toggle]; 
};

const Page = ({ children }) => <><Navbar />{children}<Footer /></>;

function Home() { 
  const navigate = useNavigate(); 
  const [mode, setMode] = useState('properties'); 
  const [location, setLocation] = useState(''); 
  const search = () => navigate(`/${mode}?q=${encodeURIComponent(location)}`); 

  return (
    <Page>
      <main>
        <section className="hero">
          <div className="hero-orb orb-one"></div>
          <div className="hero-orb orb-two"></div>
          <div className="shell hero-grid">
            <div className="hero-copy">
              <span className="pill">✦ India’s elevated rental platform</span>
              <h1>Find your <em>space.</em><br/>Ride your way.</h1>
              <p>Thoughtfully selected homes, cars, and bikes—ready for wherever life takes you next.</p>
              <div className="hero-search">
                <div className="toggle">
                  <button className={mode === 'properties' ? 'active' : ''} onClick={() => setMode('properties')}>Homes</button>
                  <button className={mode === 'vehicles' ? 'active' : ''} onClick={() => setMode('vehicles')}>Rides</button>
                </div>
                <label>⌖ <input value={location} onChange={e => setLocation(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder={mode === 'properties' ? 'Search by city or locality' : 'Search by city or vehicle'}/></label>
                <button className="btn btn-primary" onClick={search}>Search <span>→</span></button>
              </div>
              <div className="hero-proof">
                <span><b>500+</b> homes</span>
                <span><b>200+</b> vehicles</span>
                <span><b>50+</b> cities</span>
              </div>
            </div>
            <div className="hero-visual">
              <div className="visual-backdrop"></div>
              <img src="https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1100&q=85" alt="Contemporary rental home"/>
              <div className="float-card home-float"><span>From</span><strong>₹11,000</strong><small>monthly rentals</small></div>
              <div className="float-card ride-float"><span>Ready to ride</span><strong>4.8 ★</strong><small>rated experiences</small></div>
            </div>
          </div>
        </section>
        <section className="shell feature-strip">
          <div><span>01</span><h3>Verified listings</h3><p>Every listing is clearly detailed so you can choose with confidence.</p></div>
          <div><span>02</span><h3>One seamless search</h3><p>Move between your next home and your next journey effortlessly.</p></div>
          <div><span>03</span><h3>Request with clarity</h3><p>Send a complete booking request in just a few considered steps.</p></div>
        </section>
        <section id="about" className="showcase shell">
          <div>
            <span className="eyebrow">Made for movement</span>
            <h2>More than listings.<br/>A better starting point.</h2>
            <p>RentSphere brings real estate and vehicle rentals together in a calm, intuitive experience built around how people actually plan.</p>
            <Link className="text-link large" to="/properties">Explore rental homes →</Link>
          </div>
          <div className="showcase-cards">
            <Link to="/properties" className="mini-feature property"><span>⌂</span><h3>A place to settle in</h3><p>Find your next rental home.</p></Link>
            <Link to="/vehicles" className="mini-feature vehicle"><span>⌁</span><h3>A way to get there</h3><p>Choose a car or bike.</p></Link>
          </div>
        </section>
      </main>
    </Page>
  );
}

function Listings({ type }) {
  const isProperty = type === 'property';
  const defaultSource = isProperty ? properties : vehicles;
  const [apiListings, setApiListings] = useState([]);
  const [saved, toggle] = useSaved();
  const routerLocation = useLocation();
  const [filters, setFilters] = useState(() => ({ q: new URLSearchParams(window.location.search).get('q') || '', cat: 'All', sort: 'recommended', ...readLocationParams(window.location.search) }));

  // Footer city links (?city=Pune) and page switches re-apply the city/area from the URL
  useEffect(() => {
    setFilters(f => ({ ...f, ...readLocationParams(routerLocation.search) }));
  }, [routerLocation.key, type]);

  useEffect(() => {
    fetch(`/api/listings?type=${type}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        if (Array.isArray(data)) {
          const formatted = data.map(item => ({
            ...item,
            id: item._id || item.id,
            title: item.title || item.name,
            name: item.name || item.title,
            kind: item.category || (type === 'vehicle' ? 'Car' : 'Apartment'),
            owner: item.host?.name || 'Community Host',
            brand: item.host?.name || 'RentSphere Partner'
          }));
          setApiListings(formatted);
        }
      })
      .catch(() => {});
  }, [type]);

  const source = useMemo(() => {
    const all = [...apiListings, ...defaultSource];
    return isProperty ? all.map(applyStoredPropertyStatus) : all;
  }, [apiListings, defaultSource, isProperty]);

  const filtered = useMemo(() => source.filter(item => {
    const text = (`${item.title || item.name || ''} ${item.location || ''} ${item.type || ''} ${item.kind || ''} ${item.category || ''}`).toLowerCase();
    const matchesCategory = filters.cat === 'All' || item.type === filters.cat || item.kind === filters.cat || item.category === filters.cat;
    return text.includes(filters.q.toLowerCase()) && matchesCategory && matchesLocation(item.location, filters.city, filters.area);
  }).sort((a, b) => filters.sort === 'low' ? a.price - b.price : filters.sort === 'high' ? b.price - a.price : 0), [source, filters]);

  const options = isProperty ? ['All', 'Apartment', 'House', 'Villa', 'Studio'] : ['All', 'Car', 'Bike', 'SUV', 'Sedan', 'Scooter', 'Electric'];

  return (
    <Page>
      <main className="listing-page">
        <div className="listing-head shell">
          <span className="eyebrow">{isProperty ? 'Homes to make your own' : 'The road is open'}</span>
          <h1>{isProperty ? 'Find a space that feels right.' : 'Take the better route.'}</h1>
          <p>{isProperty ? 'Browse a curated selection of rental homes with clear details and verified amenities.' : 'Choose from dependable everyday rides and unforgettable weekend machines.'}</p>
        </div>
        <section className="filter-wrap">
          <div className="shell filters">
            <label className="search-field">⌕
              <input value={filters.q} onChange={e => setFilters({...filters, q: e.target.value})} placeholder={isProperty ? 'Search location or property' : 'Search city or vehicle'}/>
            </label>
            <div className="chips">
              {options.map(x => <button key={x} className={filters.cat === x ? 'active' : ''} onClick={() => setFilters({...filters, cat: x})}>{x}</button>)}
            </div>
            <select value={filters.city} onChange={e => setFilters({...filters, city: e.target.value, area: ''})} aria-label="Filter by city" style={{marginLeft: 0}}>
              <option value="">All cities</option>
              {CITIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            {filters.city && (
              <select value={filters.area} onChange={e => setFilters({...filters, area: e.target.value})} aria-label={`Filter by ${filters.city} area`} style={{marginLeft: 0}}>
                <option value="">All {filters.city}</option>
                {getCity(filters.city).areas.map(a => <option key={a.value} value={a.value}>{a.value}</option>)}
              </select>
            )}
            <select value={filters.sort} onChange={e => setFilters({...filters, sort: e.target.value})} aria-label="Sort listings">
              <option value="recommended">Recommended</option>
              <option value="low">Price: low to high</option>
              <option value="high">Price: high to low</option>
            </select>
          </div>
        </section>
        <section className="shell result-section">
          <div className="results-note">
            <span>{filtered.length} {isProperty ? 'properties' : 'vehicles'} available</span>
            <span>•</span>
            <span>Updated for your search</span>
          </div>
          <div className="cards-grid">
            {filtered.map(x => isProperty ? <PropertyCard key={x.id || x._id} item={x} saved={saved.has(x.id || x._id)} onSave={toggle}/> : <VehicleCard key={x.id || x._id} item={x} saved={saved.has(x.id || x._id)} onSave={toggle}/>)}
          </div>
          {!filtered.length && (filters.city
            ? <div className="empty-state"><h2>No {isProperty ? 'properties' : 'vehicles'} available in this location.</h2><p>No matching {isProperty ? 'properties' : 'vehicles'} in {filters.area || filters.city} right now. Try another location or clear the location filter.</p></div>
            : <div className="empty-state"><h2>No close matches yet.</h2><p>Try another location or filter.</p></div>)}
        </section>
      </main>
    </Page>
  );
}

function Detail({ type }) {
  const { id } = useParams();
  const isProperty = type === 'property';
  const defaultSource = isProperty ? properties : vehicles;
  
  const [item, setItem] = useState(() => {
    const found = defaultSource.find(x => x.id === id);
    return isProperty ? applyStoredPropertyStatus(found) : found;
  });
  const [saved, toggle] = useSaved();
  const [booking, setBooking] = useState(false);
  const [active, setActive] = useState(0);
  const [visitRequested, setVisitRequested] = useState(() => isProperty && readStoredIds(PROPERTY_VISIT_KEY).has(id));
  const [visitDecision, setVisitDecision] = useState(null);
  const [decisionError, setDecisionError] = useState('');

  useEffect(() => {
    if (!item || item._id || (id && id.length > 10)) {
      fetch(`/api/listings/${id}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && (data._id || data.id)) {
            const loaded = {
              ...data,
              id: data._id || data.id,
              title: data.title || data.name,
              name: data.name || data.title,
              kind: data.category || (type === 'vehicle' ? 'Car' : 'Apartment'),
              owner: data.host?.name || 'Community Host',
              phone: data.host?.email || '+91 98765 43210',
              brand: data.host?.name || 'RentSphere Partner',
              gallery: (data.gallery && data.gallery.length > 0) ? data.gallery : [data.image || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1200&q=85']
            };
            setItem(isProperty ? applyStoredPropertyStatus(loaded) : loaded);
          }
        })
        .catch(() => {});
    }
  }, [id, type]);

  if (!item) return <Page><div className="empty-state shell"><h1>Listing not found</h1><Link className="btn btn-primary" to={isProperty ? '/properties' : '/vehicles'}>Back to listings</Link></div></Page>;

  const images = (item.gallery && item.gallery.length > 0) ? item.gallery : [item.image, item.image, item.image];
  const itemId = item.id || item._id;
  const similar = defaultSource.filter(x => x.id !== itemId).slice(0, 3);
  const listingRented = isProperty && isRentedProperty(item);

  const recordVisitRequest = () => {
  const visits = readStoredIds(PROPERTY_VISIT_KEY);
  visits.add(itemId);
  localStorage.setItem(PROPERTY_VISIT_KEY, JSON.stringify([...visits]));
  setVisitRequested(true);
};

const declineProperty = () => {
  const visits = readStoredIds(PROPERTY_VISIT_KEY);
  visits.delete(itemId);
  localStorage.setItem(PROPERTY_VISIT_KEY, JSON.stringify([...visits]));
  setVisitRequested(false);
};

const openDecisionWhatsApp = () => {
  const propertyName = item.title || item.name || 'the property';

  const message = visitDecision === 'interested'
    ? `Hello, I requested a visit for your property "${propertyName}" on RentSphere. After visiting, I am interested in renting it. Please contact me to discuss the rent, payment, agreement and next steps.`
    : `Hello, I requested a visit for your property "${propertyName}" on RentSphere. After visiting, I have decided not to proceed. Thank you for your time.`;

  window.open(
    `https://wa.me/919403570134?text=${encodeURIComponent(message)}`,
    '_blank',
    'noopener,noreferrer'
  );

  if (visitDecision === 'not-interested') {
    declineProperty();
  }

  setVisitDecision(null);
  setDecisionError('');
};

  return (
    <Page>
      <main className="detail-page shell">
        <Link className="back-link" to={isProperty ? '/properties' : '/vehicles'}>← Back to {isProperty ? 'properties' : 'vehicles'}</Link>
        <section className="detail-top">
          <div>
            <span className="eyebrow">{isProperty ? `${item.type || 'Property'} · ${listingRented ? 'Currently Rented' : item.availability || 'Available'}` : `${item.kind || item.category || 'Vehicle'} · ${item.badge || 'Available'}`}</span>
            <h1>{item.title || item.name}</h1>
            <p className="location">⌖ {item.location}</p>
          </div>
          <div className="detail-actions">
            <button className={`save-button ${saved.has(itemId) ? 'saved' : ''}`} onClick={() => toggle(itemId)}>{saved.has(itemId) ? '♥ Saved' : '♡ Save'}</button>
            {isProperty
              ? (listingRented
                  ? <span className="property-rented-label">🔴 Currently Rented</span>
                  : <button className="btn btn-primary" onClick={() => setBooking(true)}>Request a visit →</button>)
              : <button className="btn btn-primary" onClick={() => setBooking(true)}>Book now →</button>}
          </div>
        </section>
        <section className="gallery">
          <img src={images[active] || images[0]} alt={item.title || item.name}/>
          <div>
            {images.map((img, i) => (
              <button key={i} className={active === i ? 'selected' : ''} onClick={() => setActive(i)}>
                <img src={img} alt={`View ${i + 1}`}/>
              </button>
            ))}
          </div>
        </section>
        <section className="detail-layout">
          <div>
            <article className="info-card">
              <h2>At a glance</h2>
              <div className="spec-grid">
                {(isProperty 
                  ? [['Monthly rent', `₹${formatPrice(item.price)}`], ['Home size', `${item.area || 850} sq.ft`], ['Layout', `${item.bhk || 2} BHK`], ['Furnishing', item.furnishing || 'Semi-furnished'], ['Floor', item.floor || '2nd floor'], ['Rating', `★ ${item.rating || 4.5}`]]
                  : [['Daily rental', `₹${formatPrice(item.price)}`], ['Fuel', item.fuel || 'Petrol'], ['Transmission', item.transmission || 'Manual'], ['Seats', item.seats || 5], ['Category', item.category || item.type || 'Car'], ['Rating', `★ ${item.rating || 4.5}`]]
                ).map(([a, b]) => <div key={a}><span>{a}</span><strong>{b}</strong></div>)}
              </div>
            </article>
            <article className="info-card">
              <h2>About this {isProperty ? 'home' : 'ride'}</h2>
              <p>{item.description || (isProperty ? 'A beautiful and spacious rental property.' : 'A carefully maintained vehicle ready for your trip.')}</p>
            </article>
            {isProperty && !listingRented && visitRequested && <article className="info-card rental-decision" aria-live="polite">
              <span className="eyebrow">After your visit</span>
              <h2>Did you like this property?</h2>
              <p>After visiting the property, return to RentSphere and select Interested or Not Interested to share your decision with the owner via WhatsApp.</p>
              <div className="decision-actions">
                <button className="btn btn-primary" onClick={() => { setVisitDecision('interested'); setDecisionError(''); }}>Interested</button>
                <button className="save-button" onClick={() => { setVisitDecision('not-interested'); setDecisionError(''); }}>Not Interested</button>
              </div>
            </article>}
            <article className="info-card">
              <h2>{isProperty ? 'Amenities' : 'Included features'}</h2>
              <div className="amenities">
                {(item.amenities || item.features || ['Air conditioning', '24/7 support', 'Verified listing']).map(x => <span key={x}>✓ {x}</span>)}
              </div>
            </article>
          </div>
          <aside>
            <div className="owner-card">
              <span className="eyebrow">{isProperty ? 'Property owner' : 'Rental partner'}</span>
              <div className="owner-avatar">{(item.owner || item.brand || 'O')[0]}</div>
              <h3>{item.owner || `${item.brand || 'RentSphere'} Partner`}</h3>
              <p>{item.phone || '+91 98765 43210'}</p>
              {isProperty
                ? (!listingRented && <button className="text-link" onClick={() => setBooking(true)}>Request a visit →</button>)
                : <button className="text-link" onClick={() => setBooking(true)}>Contact & book →</button>}
            </div>
            <div className="rental-note">
              <strong>Good to know</strong>
              <p>This is a rental listing on RentSphere. Your request is stored securely in the database.</p>
            </div>
          </aside>
        </section>
        <section className="similar">
          <span className="eyebrow">Keep exploring</span>
          <h2>Similar {isProperty ? 'homes' : 'rides'}</h2>
          <div className="cards-grid">
            {similar.map(x => isProperty ? <PropertyCard key={x.id || x._id} item={x} saved={saved.has(x.id || x._id)} onSave={toggle}/> : <VehicleCard key={x.id || x._id} item={x} saved={saved.has(x.id || x._id)} onSave={toggle}/>)}
          </div>
        </section>
      </main>
      {booking && (isProperty
        ? <PropertyVisitModal item={item} onClose={() => setBooking(false)} onVisitRequested={recordVisitRequest}/>
        : <BookingModal item={item} mode="vehicle" onClose={() => setBooking(false)}/>)}
      {isProperty && visitDecision && <div className="modal-backdrop" role="presentation" onMouseDown={() => setVisitDecision(null)}>
        <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="visit-decision-heading" onMouseDown={e => e.stopPropagation()}>
          <button className="modal-close" aria-label="Close" onClick={() => setVisitDecision(null)}>×</button>
          <span className="eyebrow">Property visit update</span>
          <h2 id="visit-decision-heading">{visitDecision === 'interested' ? '❤️ Interested in this property?' : 'Not interested in this property?'}</h2>
          <p className="modal-subtitle">{visitDecision === 'interested'
            ? 'Your interest message will open in WhatsApp. Please send it to the owner to discuss rental details and next steps.'
            : 'Your decision message will open in WhatsApp. Please send it to the owner. The property will remain available.'}</p>
          {decisionError && <p className="form-error" role="alert">{decisionError}</p>}
          <div className="decision-actions">
            <button className="btn btn-primary" onClick={openDecisionWhatsApp}>Continue to WhatsApp →</button>
            <button className="save-button" onClick={() => setVisitDecision(null)}>Cancel</button>
          </div>
        </section>
      </div>}
    </Page>
  );
}

function PropertyDetailRoute() {
  const { id } = useParams();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  return <Detail key={id} type="property" />;
}

function VehicleDetailRoute() {
  const { id } = useParams();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  return <Detail key={id} type="vehicle" />;
}
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home/>}/>
      <Route path="/properties" element={<Listings type="property"/>}/>
      <Route path="/properties/:id" element={<PropertyDetailRoute/>}/>
      <Route path="/vehicles" element={<Listings type="vehicle"/>}/>
      <Route path="/vehicles/:id" element={<VehicleDetailRoute />} />
      <Route path="/about" element={<AboutPage/>}/>
      <Route path="/contact" element={<ContactPage/>}/>
      <Route path="/login" element={<AuthForm/>}/>
      <Route path="/register" element={<AuthForm register/>}/>
      <Route path="/admin" element={<Page><AdminPanel/></Page>}/>
      <Route path="/dashboard" element={<Page><UserDashboard/></Page>}/>
      <Route path="/become-owner" element={<Page><OwnerOnboarding/></Page>}/>
      <Route path="*" element={<Home/>}/>
    </Routes>
  );
}

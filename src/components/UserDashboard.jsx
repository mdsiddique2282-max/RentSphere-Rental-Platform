import { useContext, useState, useEffect } from 'react';
import { AuthContext } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { formatPrice } from '../data/listings';

function OwnerStatusBanner({ user }) {
  const [ownerProfile, setOwnerProfile] = useState(null);

  useEffect(() => {
    if (!user || user.role !== 'owner' || !user.token) return;
    fetch('/api/owner/me', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => data && setOwnerProfile(data.ownerProfile))
      .catch(() => {});
  }, [user]);

  if (!user || user.role !== 'owner' || !ownerProfile) return null;

  const status = ownerProfile.status;
  const config = {
    approved: { bg: '#e0f7ec', color: 'var(--green)', text: '✓ Verified Owner — your application has been approved.' },
    pending: { bg: '#fff8e6', color: '#a15c00', text: '⏳ Your owner application is pending admin review.' },
    rejected: { bg: '#fff5f5', color: '#c53030', text: 'Your owner application was rejected. You can edit and resubmit it.' },
    in_progress: { bg: '#eef2ff', color: 'var(--blue)', text: 'Finish your owner onboarding to get verified.' }
  }[status] || { bg: '#eef2ff', color: 'var(--blue)', text: 'Complete your owner onboarding to get verified.' };

  return (
    <div style={{ background: config.bg, color: config.color, padding: '14px 18px', borderRadius: '10px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', fontWeight: 'bold' }}>
      <span>{config.text}</span>
      {status !== 'approved' && <Link to="/become-owner" style={{ color: config.color, textDecoration: 'underline' }}>Continue application →</Link>}
    </div>
  );
}

export default function UserDashboard() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  
  const [form, setForm] = useState({
    type: 'property',
    name: '',
    category: 'Apartment',
    location: '',
    price: '',
    description: ''
  });

  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  
  const [myListings, setMyListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [deleteModal, setDeleteModal] = useState(null);

  // Fetch user's uploaded listings
  const fetchMyListings = async () => {
    if (!user || !user.token) return;
    try {
      setLoadingListings(true);
      const res = await fetch('/api/listings/mine', {
        headers: { Authorization: `Bearer ${user.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMyListings(data);
      }
    } catch (err) {
      console.warn('Failed to load user listings:', err);
    } finally {
      setLoadingListings(false);
    }
  };

  useEffect(() => {
    if (!user || user.role === 'admin') {
      navigate('/');
      return;
    }
    fetchMyListings();
  }, [user, navigate]);

  // Handle Type Change & adjust category default
  const handleTypeChange = (e) => {
    const type = e.target.value;
    setForm({
      ...form,
      type,
      category: type === 'property' ? 'Apartment' : 'Car'
    });
  };

  // Handle Image Selection with Preview
  const handleImageChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (!selectedFiles.length) return;

    setFiles(prevFiles => [...prevFiles, ...selectedFiles]);

    const newPreviews = selectedFiles.map(file => URL.createObjectURL(file));
    setPreviews(prevPreviews => [...prevPreviews, ...newPreviews]);
  };

  // Remove individual preview image
  const removeImage = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setPreviews(prev => prev.filter((_, i) => i !== index));
  };

  // Submit Listing
  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSuccess('');
    setError('');

    try {
      const formData = new FormData();
      formData.append('type', form.type);
      formData.append('name', form.name);
      formData.append('title', form.name);
      formData.append('category', form.category);
      formData.append('location', form.location);
      formData.append('price', form.price);
      formData.append('description', form.description);

      files.forEach(file => {
        formData.append('images', file);
      });

      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData
      });

      let resData = {};
      try {
        const text = await res.text();
        resData = text ? JSON.parse(text) : {};
      } catch (e) {
        console.warn('Failed to parse response text:', e);
      }

      if (!res.ok) {
        throw new Error(resData.message || `Failed to upload listing (Server status ${res.status})`);
      }

      setSuccess(`Successfully published "${resData.title || resData.name || 'your product'}"!`);
      
      // Reset form
      setForm({
        type: 'property',
        name: '',
        category: 'Apartment',
        location: '',
        price: '',
        description: ''
      });
      setFiles([]);
      setPreviews([]);
      
      // Refresh user listings list
      fetchMyListings();
    } catch (err) {
      console.error('Error creating listing:', err);
      setError(err.message || 'Error publishing listing. Please check connection.');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete User Listing
const handleDeleteListing = (listingId) => {
  setDeleteModal(listingId);
};

// Confirm Listing Deletion
const confirmDeleteListing = async () => {
  if (!deleteModal) return;

  const listingId = deleteModal;

  try {
    const res = await fetch(`/api/listings/${listingId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` }
    });

    let errMessage = 'Failed to delete listing';

    try {
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (data.message) errMessage = data.message;
    } catch (e) {}

    if (!res.ok) {
      throw new Error(errMessage);
    }

    setMyListings(prev => prev.filter(item => item._id !== listingId));
    setSuccess('Listing deleted successfully.');
    setDeleteModal(null);

  } catch (err) {
    alert(err.message || 'Failed to delete listing.');
  }
};

  if (!user || user.role === 'admin') {
    return <div className="shell" style={{padding: '100px 0'}}>Unauthorized. Please log in as a user.</div>;
  }

  const dashboardTitle = user.role === 'owner' ? 'Owner Dashboard' : 'User Dashboard';

  const categoryOptions = form.type === 'property' 
    ? ['Apartment', 'House', 'Villa', 'Studio'] 
    : ['Car', 'Bike', 'SUV', 'Sedan', 'Scooter', 'Electric'];

  return (
    <div className="shell" style={{padding: '60px 0'}}>
      <div style={{marginBottom: '30px'}}>
        <span className="eyebrow">{dashboardTitle}</span>
        <h1>Welcome back, {user.name} 👋</h1>
        <p style={{color: 'var(--muted)'}}>Manage your rental listings or upload new products to RentSphere.</p>
      </div>

      <OwnerStatusBanner user={user} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '30px', alignItems: 'start' }}>
        
        {/* Upload Form */}
        <div style={{ background: '#fff', padding: '30px', borderRadius: '15px', border: '1px solid var(--line)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
          <h2>Host a New Rental / Product</h2>
          <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Add your room, villa, car, or bike for users to discover.</p>

          <form onSubmit={submit}>
            <div style={{display: 'flex', gap: '15px', marginBottom: '15px'}}>
              <label style={{flex: 1, fontWeight: 'bold'}}>
                Listing Type
                <select 
                  style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)', background: '#fff'}}
                  value={form.type} 
                  onChange={handleTypeChange}
                >
                  <option value="property">Room / Property</option>
                  <option value="vehicle">Car / Bike / Vehicle</option>
                </select>
              </label>

              <label style={{flex: 1, fontWeight: 'bold'}}>
                Category
                <select 
                  style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)', background: '#fff'}}
                  value={form.category} 
                  onChange={e => setForm({...form, category: e.target.value})}
                >
                  {categoryOptions.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </label>
            </div>

            <label style={{display: 'block', marginBottom: '15px', fontWeight: 'bold'}}>
              Title / Name
              <input 
                required
                style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)'}}
                placeholder={form.type === 'property' ? "e.g. Luxury 2 BHK Apartment in Bandra" : "e.g. Honda City VX 2024"}
                value={form.name} 
                onChange={e => setForm({...form, name: e.target.value})}
              />
            </label>

            <div style={{display: 'flex', gap: '15px', marginBottom: '15px'}}>
              <label style={{flex: 1, fontWeight: 'bold'}}>
                Location
                <input 
                  required
                  style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)'}}
                  placeholder="City or Locality"
                  value={form.location} 
                  onChange={e => setForm({...form, location: e.target.value})}
                />
              </label>
              <label style={{flex: 1, fontWeight: 'bold'}}>
                Price (₹)
                <input 
                  required type="number" min="1"
                  style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)'}}
                  placeholder={form.type === 'property' ? "Monthly rent" : "Daily rent"}
                  value={form.price} 
                  onChange={e => setForm({...form, price: e.target.value})}
                />
              </label>
            </div>

            <label style={{display: 'block', marginBottom: '15px', fontWeight: 'bold'}}>
              Description
              <textarea 
                required rows="3"
                style={{width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)', resize: 'vertical'}}
                placeholder="Provide detailed description about features, rules, or condition..."
                value={form.description} 
                onChange={e => setForm({...form, description: e.target.value})}
              />
            </label>

            {/* Image File Upload & Preview */}
            <div style={{marginBottom: '20px'}}>
              <label style={{display: 'block', fontWeight: 'bold', marginBottom: '5px'}}>
                Upload Product Images (Multiple allowed)
              </label>
              <input 
                type="file" 
                accept="image/*" 
                multiple 
                onChange={handleImageChange}
                style={{width: '100%', padding: '8px', border: '1px dashed var(--line)', borderRadius: '8px', background: '#fafafa', cursor: 'pointer'}}
              />

              {/* Preview thumbnails */}
              {previews.length > 0 && (
                <div style={{marginTop: '15px'}}>
                  <p style={{fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '8px'}}>Selected Images Preview ({previews.length}):</p>
                  <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
                    {previews.map((src, i) => (
                      <div key={i} style={{position: 'relative', width: '70px', height: '70px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--line)'}}>
                        <img src={src} alt={`Preview ${i+1}`} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
                        <button 
                          type="button"
                          onClick={() => removeImage(i)}
                          title="Remove image"
                          style={{position: 'absolute', top: '2px', right: '2px', background: 'rgba(0,0,0,0.7)', color: '#fff', border: 'none', borderRadius: '50%', width: '18px', height: '18px', fontSize: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {error && <p style={{color: 'red', fontWeight: 'bold', marginBottom: '15px'}}>{error}</p>}
            {success && <p style={{color: 'var(--green)', fontWeight: 'bold', marginBottom: '15px'}}>✓ {success}</p>}

            <button className="btn btn-primary" disabled={submitting} style={{width: '100%', justifyContent: 'center'}}>
              {submitting ? 'Publishing Product...' : 'Publish Product →'}
            </button>
          </form>
        </div>

        {/* My Uploaded Listings */}
        <div style={{ background: '#fff', padding: '30px', borderRadius: '15px', border: '1px solid var(--line)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
          <h2>My Uploaded Products ({myListings.length})</h2>
          <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Manage products you have published on RentSphere.</p>

          {loadingListings ? (
            <p style={{padding: '20px', color: 'var(--muted)'}}>Loading your listings...</p>
          ) : myListings.length === 0 ? (
            <div style={{textAlign: 'center', padding: '40px 20px', background: '#fdfdfd', borderRadius: '10px', border: '1px dashed var(--line)'}}>
              <p style={{color: 'var(--muted)', marginBottom: '10px'}}>You haven't uploaded any products yet.</p>
              <small>Use the form to host your first property or ride!</small>
            </div>
          ) : (
            <div style={{display: 'flex', flexDirection: 'column', gap: '15px', maxHeight: '600px', overflowY: 'auto', paddingRight: '5px'}}>
              {myListings.map(item => (
                <div key={item._id} style={{display: 'flex', gap: '15px', padding: '15px', border: '1px solid var(--line)', borderRadius: '10px', alignItems: 'center', background: '#fff'}}>
                  <img 
                    src={item.image || (item.gallery && item.gallery[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=400&q=80'} 
                    alt={item.title || item.name} 
                    style={{width: '80px', height: '65px', objectFit: 'cover', borderRadius: '8px'}}
                  />
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--blue)', textTransform: 'uppercase'}}>
                      {item.type} · {item.category}
                    </div>
                    <h4 style={{margin: '2px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                      {item.title || item.name}
                    </h4>
                    <p style={{fontSize: '0.85rem', color: 'var(--muted)', margin: 0}}>
                      ⌖ {item.location} · <strong>₹{formatPrice(item.price)}</strong>/{item.type === 'property' ? 'mo' : 'day'}
                    </p>
                  </div>
                  <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
                    <Link to={`/${item.type === 'property' ? 'properties' : 'vehicles'}/${item._id}`} style={{fontSize: '0.8rem', color: 'var(--blue)', textAlign: 'center'}}>
                      View
                    </Link>
                    <button 
                      onClick={() => handleDeleteListing(item._id)}
                      style={{background: '#fff0f0', color: '#d9534f', border: '1px solid #f5c6cb', padding: '4px 10px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer'}}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
      {deleteModal && (
        <div className="delete-modal-overlay">
          <div className="delete-modal">
            <h2>Confirm Deletion</h2>

            <p>
              Are you sure you want to delete this listing?
              This action cannot be undone.
            </p>

            <div className="delete-modal-actions">
              <button
                type="button"
                onClick={() => setDeleteModal(null)}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={confirmDeleteListing}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
}

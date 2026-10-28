import { openPrivateOwnerDocument } from '../data/ownerDocuments';
import HistoryConfirmation from './HistoryConfirmation';
import { useContext, useCallback, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { formatPrice } from '../data/listings';
import ListingControls from './ListingControls';
import AdminRequests from './AdminRequests';
import HostingForm from './HostingForm';

export function filterAdminProducts(products, type, search) {
  const query = search.trim().toLowerCase();
  return products.filter(product => (type === 'all' || product.type === type) && [product.title, product.name].some(value => String(value || '').toLowerCase().includes(query)));
}
export const adminListingPath = product => `/${product.type === 'property' ? 'properties' : 'vehicles'}/${product._id}`;
export function AdminProductFilters({ products, type, search, onTypeChange, onSearchChange }) {
  return <div className="admin-product-filters"><div className="admin-product-tabs" role="group" aria-label="Product type">
    {[['all', 'All Products'], ['property', 'Properties'], ['vehicle', 'Vehicles']].map(([value, label]) => <button type="button" key={value} className={`admin-product-tab${type === value ? ' is-active' : ''}`} aria-pressed={type === value} onClick={() => onTypeChange(value)}>{label} ({value === 'all' ? products.length : products.filter(product => product.type === value).length})</button>)}
  </div><label className="admin-product-search"><span>Search products</span><input type="search" placeholder="Search properties or vehicles by name..." value={search} onChange={event => onSearchChange(event.target.value)} /></label></div>;
}

export default function AdminPanel() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [usersList, setUsersList] = useState([]);
  const [productsList, setProductsList] = useState([]);
  const [productType, setProductType] = useState('all'), [productSearch, setProductSearch] = useState('');
  const [ownersList, setOwnersList] = useState([]);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [revoke, setRevoke] = useState(null), [revoking, setRevoking] = useState(false), [revokeError, setRevokeError] = useState('');
  const ownerActionLock = useRef(false), documentCleanups = useRef([]), tokenRef = useRef(user?.token); tokenRef.current = user?.token;
  const closeRevoke = useCallback(() => { setRevoke(null); setRevokeError(''); }, []);
  useEffect(() => () => { documentCleanups.current.forEach(clean => clean()); documentCleanups.current = []; }, [user?.token]);
  const openOwnerDocument = async (event, ownerId, index) => {
    event.preventDefault(); const token = user.token; setErrorMsg('');
    try { const cleanup = await openPrivateOwnerDocument({ ownerId, index, token, isCurrent: () => tokenRef.current === token }); documentCleanups.current.push(cleanup); }
    catch (error) { if (tokenRef.current === token) setErrorMsg(error.message || 'Unable to open the document.'); }
  };
  const revokeOwner = async () => {
    if (!revoke || ownerActionLock.current || revoke.token !== user.token) return;
    const token = user.token; ownerActionLock.current = true; setRevoking(true); setRevokeError('');
    try {
      const response = await fetch('/api/admin/owners/' + revoke._id + '/revoke', { method: 'PUT', headers: { Authorization: 'Bearer ' + token } });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Unable to revoke owner access.');
      if (tokenRef.current !== token) return;
      closeRevoke(); setActionMessage(data.message); await loadAdminData();
    } catch (error) { if (tokenRef.current === token) setRevokeError(error.message); }
    finally { ownerActionLock.current = false; if (tokenRef.current === token) setRevoking(false); }
  };
  const [deleteModal, setDeleteModal] = useState(null);

  const readAdmin = async (path, setter) => {
    try {
      const res = await fetch('/api/admin/' + path, { headers: { Authorization: 'Bearer ' + (user?.token || '') } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Unable to load ' + path);
      setter(data);
    } catch (error) { setErrorMsg(error.message); }
  };
  const fetchStats = () => readAdmin('stats', setStats);
  const fetchUsers = () => readAdmin('users', setUsersList);
  const fetchProducts = () => readAdmin('listings', setProductsList);

  const fetchOwners = () => readAdmin('owners', setOwnersList);

  const loadAdminData = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      await Promise.all([fetchUsers(), fetchProducts(), fetchOwners()]);
      await fetchStats();
    } catch (err) {
      setErrorMsg('Failed to load complete admin data from server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
      return;
    }
    loadAdminData();
  }, [user, navigate]);

  // Admin delete user
const handleDeleteUser = (targetUserId, targetUserName) => {
  setDeleteModal({
    type: 'user',
    id: targetUserId,
    name: targetUserName
  });
};

// Admin delete product
const handleDeleteProduct = (productId, productTitle) => {
  setDeleteModal({
    type: 'product',
    id: productId,
    name: productTitle
  });
};

// Confirm deletion
const confirmDelete = async () => {
  if (!deleteModal) return;

  const { type, id, name } = deleteModal;

  try {
    const endpoint = type === 'user'
      ? `/api/admin/users/${id}`
      : `/api/admin/listings/${id}`;

    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` }
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Delete failed');
    }

    setActionMessage(
      type === 'user'
        ? `User "${name}" and all associated products were deleted successfully.`
        : 'Product deleted successfully by admin.'
    );

    setDeleteModal(null);
    await loadAdminData();
  } catch (err) {
    setActionMessage(err.message || 'Error deleting');
    setDeleteModal(null);
  }
};

  // Step 5: Admin approves an owner application
  const handleApproveOwner = async (ownerId, ownerName) => {
    try {
      const res = await fetch(`/api/admin/owners/${ownerId}/approve`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Failed to approve owner');
      setActionMessage(data.message || `${ownerName} approved as a verified owner.`);
      fetchOwners();
    } catch (err) {
      alert(err.message || 'Error approving owner application');
    }
  };

  // Step 5: Admin rejects an owner application, optionally with a note
  const handleRejectOwner = async (ownerId) => {
    try {
      const res = await fetch(`/api/admin/owners/${ownerId}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ note: rejectNote })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Failed to reject owner');
      setActionMessage(data.message || 'Owner application rejected.');
      setRejectingId(null);
      setRejectNote('');
      fetchOwners();
    } catch (err) {
      alert(err.message || 'Error rejecting owner application');
    }
  };

  if (!user || user.role !== 'admin') {
    return (
      <div className="shell" style={{padding: '100px 0', textAlign: 'center'}}>
        <h2>Unauthorized Access</h2>
        <p style={{color: 'var(--muted)'}}>You must be logged in as an Administrator to view this page.</p>
        <Link to="/" className="btn btn-primary" style={{marginTop: '15px', display: 'inline-flex'}}>Return to Home</Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="shell" style={{padding: '100px 0', textAlign: 'center'}}>
        <div style={{fontSize: '1.2rem', fontWeight: 'bold', color: 'var(--blue)'}}>Loading Admin Panel...</div>
        <p style={{color: 'var(--muted)', marginTop: '8px'}}>Fetching users, listings, and database statistics.</p>
      </div>
    );
  }

  const visibleProducts = filterAdminProducts(productsList, productType, productSearch);

  return (
    <div className="shell" style={{padding: '40px 0 80px'}}>
      <div style={{marginBottom: '25px'}}>
        <span className="eyebrow">Admin Panel</span>
        <h1 className="admin-header-title" style={{margin: '4px 0 8px'}}>Admin Dashboard</h1>
        <p style={{color: 'var(--muted)'}}>Manage all registered users, products, categories, and system overview.</p>
      </div>

      {errorMsg && (
        <div style={{padding: '12px 20px', background: '#fff5f5', border: '1px solid #fed7d7', color: '#c53030', borderRadius: '10px', marginBottom: '25px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <span>⚠️ {errorMsg}</span>
          <button onClick={() => setErrorMsg('')} style={{background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold'}}>✕</button>
        </div>
      )}

      {actionMessage && (
        <div style={{padding: '12px 20px', background: '#e6fffa', border: '1px solid #b2f5ea', color: '#234e52', borderRadius: '10px', marginBottom: '25px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <span>✓ {actionMessage}</span>
          <button onClick={() => setActionMessage('')} style={{background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold'}}>✕</button>
        </div>
      )}

      {/* Responsive Sidebar & Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 240px) 1fr', gap: '30px', alignItems: 'start' }} className="admin-grid">
        
        {/* Sidebar Navigation */}
        <aside className="admin-navigation-sidebar" style={{ background: '#fff', padding: '20px', borderRadius: '15px', border: '1px solid var(--line)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
          <div className="admin-nav-header" style={{fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '15px', paddingLeft: '8px'}}>
            Navigation
          </div>
          <nav style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
            <button 
              onClick={() => setActiveTab('overview')}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: activeTab === 'overview' ? 'var(--blue)' : 'transparent',
                color: activeTab === 'overview' ? '#fff' : 'var(--charcoal)'
              }}
            >
              <span>📊</span> Dashboard
            </button>

            <button 
              onClick={() => setActiveTab('users')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: activeTab === 'users' ? 'var(--blue)' : 'transparent',
                color: activeTab === 'users' ? '#fff' : 'var(--charcoal)'
              }}
            >
              <span>👥 Users</span>
              <span style={{fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: activeTab === 'users' ? 'rgba(255,255,255,0.2)' : 'var(--line)'}}>
                {usersList.length}
              </span>
            </button>

            <button 
              onClick={() => setActiveTab('products')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: activeTab === 'products' ? 'var(--blue)' : 'transparent',
                color: activeTab === 'products' ? '#fff' : 'var(--charcoal)'
              }}
            >
              <span>📦 Products</span>
              <span style={{fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: activeTab === 'products' ? 'rgba(255,255,255,0.2)' : 'var(--line)'}}>
                {productsList.length}
              </span>
            </button>

            {[['vehicle_bookings', 'Vehicle Bookings'], ['property_visits', 'Property Visits']].map(([tab, label]) => <button key={tab}
              onClick={() => setActiveTab(tab)} aria-current={activeTab === tab ? 'page' : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer', background: activeTab === tab ? 'var(--blue)' : 'transparent', color: activeTab === tab ? '#fff' : 'var(--charcoal)' }}>
              <span className="admin-request-nav-icon" aria-hidden="true">{tab === 'vehicle_bookings' ? '🚘' : '🏡'}</span>{label}
            </button>)}

            <button 
              onClick={() => setActiveTab('add_product')}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: activeTab === 'add_product' ? 'var(--blue)' : 'transparent',
                color: activeTab === 'add_product' ? '#fff' : 'var(--charcoal)'
              }}
            >
              <span>➕ Add Product</span>
            </button>

            <button 
              onClick={() => setActiveTab('owners')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 15px', borderRadius: '10px', textAlign: 'left', fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: activeTab === 'owners' ? 'var(--blue)' : 'transparent',
                color: activeTab === 'owners' ? '#fff' : 'var(--charcoal)'
              }}
            >
              <span>🧾 Owner Applications</span>
              <span style={{fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: activeTab === 'owners' ? 'rgba(255,255,255,0.2)' : '#fff3cd', color: activeTab === 'owners' ? '#fff' : '#a15c00'}}>
                {ownersList.filter(o => o.ownerProfile?.status === 'pending').length}
              </span>
            </button>
          </nav>
        </aside>

        {/* Main Content Area */}
        <main style={{ minWidth: 0 }}>
          {activeTab === 'vehicle_bookings' && <AdminRequests key="vehicle" type="vehicle" />}
          {activeTab === 'property_visits' && <AdminRequests key="property_visit" type="property_visit" />}
          
          {/* SECTION 1: DASHBOARD OVERVIEW */}
          {activeTab === 'overview' && (
            <div>
              <div className="admin-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '30px' }}>
                <div className="admin-stat-card" style={{ padding: '20px', background: '#fff', border: '1px solid var(--line)', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                  <span style={{fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 'bold', textTransform: 'uppercase'}}>Total Users</span>
                  <p style={{fontSize: '2.2rem', fontWeight: 'bold', margin: '4px 0 0', color: 'var(--charcoal)'}}>
                    {stats?.totalUsers ?? '—'}
                  </p>
                </div>
                
                <div className="admin-stat-card" style={{ padding: '20px', background: '#fff', border: '1px solid var(--line)', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                  <span style={{fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 'bold', textTransform: 'uppercase'}}>Total Products</span>
                  <p style={{fontSize: '2.2rem', fontWeight: 'bold', margin: '4px 0 0', color: 'var(--blue)'}}>
                    {stats?.totalProducts ?? '—'}
                  </p>
                </div>

                <div className="admin-stat-card" style={{ padding: '20px', background: '#fff', border: '1px solid var(--line)', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                  <span style={{fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 'bold', textTransform: 'uppercase'}}>Categories</span>
                  <p style={{fontSize: '2.2rem', fontWeight: 'bold', margin: '4px 0 0', color: '#d97706'}}>
                    {stats?.totalCategories ?? '—'}
                  </p>
                </div>

                <div className="admin-stat-card" style={{ padding: '20px', background: '#fff', border: '1px solid var(--line)', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                  <span style={{fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 'bold', textTransform: 'uppercase'}}>User Uploads</span>
                  <p style={{fontSize: '2.2rem', fontWeight: 'bold', margin: '4px 0 0', color: 'var(--green)'}}>
                    {stats?.userUploadedProductsCount ?? '—'}
                  </p>
                </div>
              </div>

              {/* Recent Products */}
              <div style={{ background: '#fff', padding: '25px', borderRadius: '15px', border: '1px solid var(--line)' }}>
                <h2>Recently Added Products</h2>
                <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Overview of the latest products published across RentSphere.</p>

                {productsList.length === 0 ? (
                  <p style={{color: 'var(--muted)'}}>No products currently in the database.</p>
                ) : (
                  <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                    {productsList.slice(0, 5).map(p => (
                      <div key={p._id} style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', border: '1px solid var(--line)', borderRadius: '10px', background: '#fff', gap: '10px', flexWrap: 'wrap', maxWidth: '100%', overflow: 'hidden'}}>
                        <div style={{display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0, flex: '1 1 200px'}}>
                          <img src={p.image || (p.gallery && p.gallery[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=200&q=80'} alt="" style={{width: '50px', height: '42px', objectFit: 'cover', borderRadius: '6px', flexShrink: 0}} />
                          <div style={{minWidth: 0, flex: 1}}>
                            <strong style={{display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%'}}>{p.title || p.name}</strong>
                            <small style={{color: 'var(--muted)', display: 'block', wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: '1.4', fontSize: '0.8rem'}}>
                              {p.type} · Category: {p.category || 'Standard'} · Owner: <strong>{p.host?.name ? `${p.host.name} (${p.host.email})` : 'Admin User (admin@rentsphere.com)'}</strong>
                            </small>
                          </div>
                        </div>
                        <span style={{fontWeight: 'bold', flexShrink: 0, fontSize: '0.95rem'}}>₹{formatPrice(p.price)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SECTION 2: USERS PAGE */}
          {activeTab === 'users' && (
            <div style={{ background: '#fff', padding: '25px', borderRadius: '15px', border: '1px solid var(--line)' }}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px'}}>
                <div>
                  <h2 style={{margin: 0}}>Users Management ({usersList.length})</h2>
                  <p style={{color: 'var(--muted)', fontSize: '0.9rem', margin: '4px 0 0'}}>All registered accounts and uploaded product statistics in database.</p>
                </div>
              </div>

              {usersList.length === 0 ? (
                <div style={{padding: '40px 0', textAlign: 'center', color: 'var(--muted)'}}>
                  <p>No registered users found in database.</p>
                </div>
              ) : (
                <div className="admin-table-wrap" style={{overflowX: 'auto', WebkitOverflowScrolling: 'touch'}}>
                  <table style={{width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '600px'}}>
                    <thead>
                      <tr style={{borderBottom: '2px solid var(--line)', background: '#fafafa'}}>
                        <th style={{padding: '12px'}}>User Name</th>
                        <th style={{padding: '12px'}}>Email</th>
                        <th style={{padding: '12px'}}>Role</th>
                        <th style={{padding: '12px'}}>Uploaded Products</th>
                        <th style={{padding: '12px', textAlign: 'right'}}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usersList.map(u => (
                        <tr key={u._id} style={{borderBottom: '1px solid var(--line)'}}>
                          <td style={{padding: '14px 12px', fontWeight: 'bold'}}>{u.name || 'User'}</td>
                          <td style={{padding: '14px 12px', color: 'var(--muted)'}}>{u.email}</td>
                          <td style={{padding: '14px 12px'}}>
                            <span style={{padding: '3px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 'bold', background: u.role === 'admin' ? '#eef2ff' : '#f3f4f6', color: u.role === 'admin' ? 'var(--blue)' : 'var(--charcoal)'}}>
                              {(u.role || 'user').toUpperCase()}
                            </span>
                          </td>
                          <td style={{padding: '14px 12px', fontWeight: 'bold'}}>
                            {u.productCount || 0} products
                          </td>
                          <td style={{padding: '14px 12px', textAlign: 'right'}}>
                            {u._id === user._id ? (
                              <span style={{fontSize: '0.8rem', color: 'var(--muted)', fontStyle: 'italic'}}>Current Admin</span>
                            ) : (
                              <button 
                                onClick={() => handleDeleteUser(u._id, u.name)}
                                style={{background: '#fff0f0', color: '#d9534f', border: '1px solid #f5c6cb', padding: '5px 12px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 'bold'}}
                              >
                                Delete User
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* SECTION 3: PRODUCTS & ADD PRODUCT */}
          {(activeTab === 'products' || activeTab === 'add_product') && (
            <div>
              {/* Quick Tab Bar inside Products section */}
              <div style={{display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap'}}>
                <button 
                  onClick={() => { setProductType('all'); setActiveTab('products'); }}
                  className={`admin-product-tab${activeTab === 'products' ? ' is-active' : ''}`}
                >
                  All Products ({productsList.length})
                </button>
                <button 
                  onClick={() => setActiveTab('add_product')}
                  style={{padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--line)', background: activeTab === 'add_product' ? 'var(--blue)' : '#fff', color: activeTab === 'add_product' ? '#fff' : 'var(--blue)', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem'}}
                >
                  + Add New Product
                </button>
              </div>

              {/* PRODUCTS LIST */}
              {activeTab === 'products' && (
                <div style={{ background: '#fff', padding: '25px', borderRadius: '15px', border: '1px solid var(--line)' }}>
                  <h2>Products Management ({productsList.length})</h2>
                  <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>View, inspect, or delete products published across RentSphere.</p>

                  <AdminProductFilters products={productsList} type={productType} search={productSearch} onTypeChange={setProductType} onSearchChange={setProductSearch} />
                  {visibleProducts.length === 0 ? (
                    <div style={{padding: '40px 0', textAlign: 'center', color: 'var(--muted)'}}>
                      <p>No matching products found</p>
                    </div>
                  ) : (
                    <div className="admin-products-grid" style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '20px'}}>
                      {visibleProducts.map(p => (
                        <div key={p._id} style={{border: '1px solid var(--line)', borderRadius: '12px', overflow: 'hidden', background: '#fff', display: 'flex', flexDirection: 'column'}}>
                          <div style={{position: 'relative', height: '160px'}}>
                            <img 
                              src={p.image || (p.gallery && p.gallery[0]) || 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=400&q=80'} 
                              alt={p.title || p.name} 
                              style={{width: '100%', height: '100%', objectFit: 'cover'}}
                            />
                            <span style={{position: 'absolute', top: '8px', left: '8px', background: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: '0.7rem', padding: '3px 8px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: 'bold'}}>
                              {p.type} · {p.category || 'Standard'}
                            </span>
                          </div>

                          <div style={{padding: '14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
                            <div>
                              <h4 style={{margin: '0 0 6px 0', fontSize: '1rem'}}>{p.title || p.name}</h4>
                              <ListingControls item={p} onChanged={loadAdminData} />
                              <div style={{fontSize: '0.82rem', margin: '6px 0 10px 0', lineHeight: '1.6', color: 'var(--charcoal)'}}>
                                <div><strong>Category:</strong> {p.category || p.type}</div>
                                <div><strong>User Name:</strong> {p.host?.name || 'Admin User'}</div>
                                <div><strong>User Email:</strong> {p.host?.email || 'admin@rentsphere.com'}</div>
                              </div>
                            </div>

                            <div className="admin-product-card-actions" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: '10px', marginTop: '10px'}}>
                              <Link className="admin-product-view" to={adminListingPath(p)} target="_blank" rel="noopener noreferrer" aria-label={`View ${p.title || p.name} listing (opens in a new tab)`}>View Listing</Link>
                              <strong style={{fontSize: '0.95rem'}}>₹{formatPrice(p.price)}</strong>
                              <button 
                                onClick={() => handleDeleteProduct(p._id, p.title || p.name)}
                                style={{background: '#fff0f0', color: '#d9534f', border: '1px solid #f5c6cb', padding: '5px 12px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 'bold'}}
                              >
                                Delete Product
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ADD PRODUCT FORM */}
              {activeTab === 'add_product' && (
                <div style={{ background: '#fff', padding: '25px', borderRadius: '15px', border: '1px solid var(--line)', maxWidth: '650px' }}>
                  <h2>Add New Rental Product</h2>
                  <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Create and publish a new property or vehicle listing as Admin.</p>

                  <HostingForm token={user.token} onSaved={async listing => {
                    setProductsList(previous => [listing, ...previous.filter(product => product._id !== listing._id)]);
                    setProductType(listing.type); setProductSearch(''); setActiveTab('products');
                    setActionMessage('Product published successfully.');
                    await Promise.all([fetchProducts(), fetchStats()]);
                  }} />
                </div>
              )}

            </div>
          )}

          {/* SECTION 4: OWNER APPLICATIONS (Step 5 — Admin reviews the owner) */}
          {activeTab === 'owners' && (
            <div style={{ background: '#fff', padding: '25px', borderRadius: '15px', border: '1px solid var(--line)' }}>
              <h2>Owner Applications ({ownersList.length})</h2>
              <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Review onboarding submissions from people who want to become verified owners on RentSphere.</p>

              {ownersList.length === 0 ? (
                <div style={{padding: '40px 0', textAlign: 'center', color: 'var(--muted)'}}>
                  <p>No owner applications yet.</p>
                </div>
              ) : (
                <div style={{display: 'flex', flexDirection: 'column', gap: '15px'}}>
                  {ownersList.map(o => {
                    const p = o.ownerProfile || {};
                    const statusStyle = {
                      approved: { bg: '#e0f7ec', color: 'var(--green)', label: 'APPROVED' },
                      pending: { bg: '#fff8e6', color: '#a15c00', label: 'PENDING REVIEW' },
                      revoked: { bg: '#fff5f5', color: '#c53030', label: 'REVOKED' },
                      rejected: { bg: '#fff5f5', color: '#c53030', label: 'REJECTED' },
                      in_progress: { bg: '#eef2ff', color: 'var(--blue)', label: 'IN PROGRESS' }
                    }[p.status] || { bg: '#f3f4f6', color: 'var(--charcoal)', label: (p.status || 'UNKNOWN').toUpperCase() };

                    return (
                      <div key={o._id} style={{border: '1px solid var(--line)', borderRadius: '12px', padding: '18px', background: '#fff'}}>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px'}}>
                          <div>
                            <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px'}}>
                              <strong style={{fontSize: '1.05rem'}}>{o.name}</strong>
                              <span style={{fontSize: '0.7rem', fontWeight: 'bold', padding: '3px 9px', borderRadius: '12px', background: statusStyle.bg, color: statusStyle.color}}>
                                {statusStyle.label}
                              </span>
                            </div>
                            <div style={{fontSize: '0.85rem', color: 'var(--muted)'}}>{o.email} {p.phone ? `· ${p.phone}` : ''}</div>
                          </div>
                          {p.status === 'approved' && o.role !== 'admin' && <button className="save-button" onClick={() => { setRevokeError(''); setRevoke({ _id: o._id, token: user.token }); }}>Revoke Owner Access</button>}
                          {p.status === 'pending' && (
                            <div style={{display: 'flex', gap: '8px'}}>
                              <button
                                onClick={() => handleApproveOwner(o._id, o.name)}
                                style={{background: '#e0f7ec', color: 'var(--green)', border: '1px solid #b6ecd3', padding: '6px 14px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 'bold'}}
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => setRejectingId(rejectingId === o._id ? null : o._id)}
                                style={{background: '#fff0f0', color: '#d9534f', border: '1px solid #f5c6cb', padding: '6px 14px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 'bold'}}
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </div>

                        <div style={{fontSize: '0.82rem', lineHeight: '1.7', color: 'var(--charcoal)', marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '4px 20px'}}>
                          <div><strong>Business:</strong> {p.businessName || '—'}</div>
                          <div><strong>Location:</strong> {[p.address, p.city, p.state].filter(Boolean).join(', ') || '—'}</div>
                          <div><strong>Plans to list:</strong> {p.listingIntent || '—'}</div>
                          <div><strong>ID proof:</strong> {p.idProofType || '—'} {p.idProofNumber ? `(${p.idProofNumber})` : ''}</div>
                          <div><strong>Documents:</strong> {p.documents?.length || 0} file(s) uploaded</div>
                          <div><strong>Onboarding step:</strong> {p.currentStep || 1} / 5</div>
                        </div>

                        {p.documents?.length > 0 && (
                          <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px'}}>
                            {p.documents.map((doc, i) => (
                              <a key={i} href={`/api/owner/documents/${encodeURIComponent(o._id)}/${i}`} onClick={event => openOwnerDocument(event, o._id, i)} target="_blank" rel="noopener noreferrer" style={{fontSize: '0.78rem', color: 'var(--blue)', border: '1px solid var(--line)', borderRadius: '6px', padding: '4px 10px'}}>
                                View document {i + 1}
                              </a>
                            ))}
                          </div>
                        )}

                        {p.status === 'rejected' && p.reviewNote && (
                          <div style={{marginTop: '10px', fontSize: '0.82rem', color: '#c53030'}}><strong>Rejection note:</strong> {p.reviewNote}</div>
                        )}

                        {rejectingId === o._id && (
                          <div style={{marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed var(--line)'}}>
                            <label style={{display: 'block', fontWeight: 'bold', fontSize: '0.82rem', marginBottom: '6px'}}>Reason for rejection (optional)</label>
                            <textarea
                              rows="2"
                              value={rejectNote}
                              onChange={e => setRejectNote(e.target.value)}
                              placeholder="Let the applicant know what needs fixing..."
                              style={{width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--line)', resize: 'vertical', marginBottom: '10px'}}
                            />
                            <div style={{display: 'flex', gap: '8px'}}>
                              <button onClick={() => handleRejectOwner(o._id)} style={{background: '#d9534f', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 'bold'}}>
                                Confirm rejection
                              </button>
                              <button onClick={() => { setRejectingId(null); setRejectNote(''); }} style={{background: '#f0f4fb', color: 'var(--charcoal)', border: 'none', padding: '7px 16px', borderRadius: '6px', fontSize: '0.8rem', cursor: 'pointer'}}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </main>
      </div>

      {revoke && <HistoryConfirmation removing titleText="Revoke Owner Access?" descriptionText="This owner will lose permission to host or manage rental listings. Existing records will be preserved." confirmText="Revoke Access" busy={revoking} error={revokeError} onClose={closeRevoke} onConfirm={revokeOwner} />}
      {deleteModal && (
  <div className="delete-modal-overlay">
    <div className="delete-modal">
      <h2>Confirm Deletion</h2>

      <p>
        Are you sure you want to delete this {deleteModal.type}
        <strong> "{deleteModal.name}"</strong>?
      </p>

      {deleteModal.type === 'user' && (
        <p style={{ color: '#dc2626' }}>
          All uploaded products and images will be permanently deleted.
        </p>
      )}

      <div className="delete-modal-actions">
        <button type="button" onClick={() => setDeleteModal(null)}>
          Cancel
        </button>

        <button type="button" onClick={confirmDelete}>
          Confirm Delete
        </button>
      </div>
    </div>
  </div>
)}

    </div>
  );
}

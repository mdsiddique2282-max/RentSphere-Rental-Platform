import { useContext, useState, useEffect } from 'react';
import { AuthContext } from '../context/AuthContext';
import { useNavigate, Link, Navigate, useLocation, useParams } from 'react-router-dom';
import CustomerRequests from './CustomerRequests';
import SavedListings from './SavedListings';
import RequestNotifications from './RequestNotifications';
import HostingForm from './HostingForm';
import OwnerRequests from './OwnerRequests';
import OwnerProductCard from './OwnerProductCard';
import './OwnerDashboard.css';
import { dashboardKind } from '../data/account';
import { requestReturnPath, resolveRequestLink } from '../data/requests';
import './Dashboard.css';

export function DirectRequestLink() {
  const { id } = useParams();
  const { user, account, accountStatus, accountError, refreshAccount } = useContext(AuthContext);
  const [result, setResult] = useState(null), [retry, setRetry] = useState(0);
  const scope = `${user?.token}:${id}`;
  useEffect(() => {
    let active = true;
    setResult(null);
    if (user?.token && accountStatus === 'ready' && account) {
      resolveRequestLink({ id, account, token: user.token }).then(path => {
        if (active) setResult({ scope, path });
      }).catch(error => { if (active) setResult({ scope, error: error.message }); });
    }
    return () => { active = false; };
  }, [id, user?.token, account, accountStatus, retry]);
  const path = requestReturnPath(`/request/${id}`);
  if (!path) return <div className="shell dashboard-retry" role="alert">This request is unavailable or you do not have access.</div>;
  if (!user) return <Navigate to={`/login?returnTo=${encodeURIComponent(path)}`} replace />;
  if (accountStatus === 'error' || (result?.scope === scope && result.error)) return <div className="shell dashboard-retry" role="alert"><p>{accountStatus === 'error' ? accountError : result.error}</p><button className="btn btn-primary" onClick={() => accountStatus === 'error' ? refreshAccount() : setRetry(value => value + 1)}>Retry</button></div>;
  if (result?.scope === scope && result.path) return <Navigate to={result.path} replace />;
  return <div className="shell dashboard-retry" role="status">Opening your request…</div>;
}

export function OwnerStatusNotice({ status, approved }) {
  const config = {
    approved: { bg: '#e0f7ec', color: 'var(--green)', text: '✓ Verified Owner — your application has been approved.' },
    pending: { bg: '#fff8e6', color: '#a15c00', text: '⏳ Your owner application is pending admin review.' },
    rejected: { bg: '#fff5f5', color: '#c53030', text: 'Your owner application was rejected. You can edit and resubmit it.' },
    in_progress: { bg: '#eef2ff', color: 'var(--blue)', text: 'Finish your owner onboarding to get verified.' }
  }[status] || { bg: '#eef2ff', color: 'var(--blue)', text: 'Complete your owner onboarding to get verified.' };

  return (
    <div style={{ background: config.bg, color: config.color, padding: '14px 18px', borderRadius: '10px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', fontWeight: 'bold' }}>
      <span>{config.text}</span>
      {status === 'approved' && approved && <a href="#hosting-form" style={{ color: config.color, textDecoration: 'underline' }} onClick={e => { e.preventDefault(); const target = document.getElementById('hosting-form'); target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); target?.focus({ preventScroll: true }); }}>Want to add a product? →</a>}
      {status !== 'approved' && <Link to="/become-owner" style={{ color: config.color, textDecoration: 'underline' }}>Continue application →</Link>}
    </div>
  );
}

export function OwnerDashboard() {
  const { user, account, accountStatus } = useContext(AuthContext);
  const navigate = useNavigate();
  const canManage = accountStatus === 'ready' && dashboardKind(account) === 'owner';
  const [myListings, setMyListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [deleteModal, setDeleteModal] = useState(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

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
      } else setError('Unable to load your products. Please try again.');
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

  // Delete User Listing
const handleDeleteListing = (listingId) => {
  setDeleteModal(listingId);
};

// Confirm Listing Deletion
const confirmDeleteListing = async () => {
  if (!deleteModal || deleting) return;
  setDeleting(true); setError('');

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

    setDeleteModal(null);

  } catch (err) {
    setError(err.message || 'Failed to delete listing.');
  } finally {
    setDeleting(false);
  }
};

  if (!user || user.role === 'admin') {
    return <div className="shell" style={{padding: '100px 0'}}>Unauthorized. Please log in as a user.</div>;
  }

  const dashboardTitle = 'Owner Dashboard';

  return (
    <div className="shell owner-dashboard">
      <div className="owner-dashboard-header">
        <span className="eyebrow">{dashboardTitle}</span>
        <h1>Owner Dashboard</h1><p className="owner-welcome">Welcome back, {user.name} 👋</p>
        <p style={{color: 'var(--muted)'}}>Manage your listings, customer requests and rentals from one place.</p>
      </div>

      <OwnerStatusNotice status="approved" approved={canManage} />
      <div className="dashboard-owner-sections">
        {/* My Uploaded Listings */}
        <div className="owner-products-card">
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
            <div className="dashboard-products-list">
              {myListings.map(item => <OwnerProductCard key={item._id} item={item} canManage={canManage} onChanged={fetchMyListings} onDelete={handleDeleteListing} />)}
            </div>
          )}
        </div>

        {canManage && <OwnerRequests />}
        {/* Upload Form */}
        <div id="hosting-form" tabIndex={-1} className="owner-products-card">
          <h2>Host a New Rental / Product</h2>
          <p style={{color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px'}}>Add your room, villa, car, or bike for users to discover.</p>

          {!canManage && <p>Publishing and listing management require admin approval. <Link className="text-link" to="/become-owner">Continue owner application</Link></p>}
          <fieldset disabled={!canManage} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><HostingForm token={user.token} onSaved={fetchMyListings} /></fieldset>
        </div>


        <RequestNotifications />
        <CustomerRequests />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {deleteModal && (
        <div className="delete-modal-overlay">
          <div className="delete-modal">
            <h2>Confirm Deletion</h2>{error && <p className="form-error" role="alert">{error}</p>}

            <p>
              Are you sure you want to delete this listing?
              Existing booking, visit and saved-listing history will be preserved.
            </p>

            <div className="delete-modal-actions">
              <button
                type="button"
                disabled={deleting} onClick={() => setDeleteModal(null)}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deleting} onClick={confirmDeleteListing}
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

export function OwnerApplicationBanner({ profile = {} }) {
  if (profile.status === 'pending') return <section className="owner-promotion" aria-label="Owner application status"><div><h2>Application Under Review</h2><p>Your owner application has been submitted and is awaiting admin approval.</p></div></section>;
  if (profile.status === 'rejected') return <section className="owner-promotion application-rejected" aria-label="Owner application status"><div><h2>Application Rejected</h2><p>{profile.reviewNote || 'Your application was not approved. You can review and edit your existing application before resubmitting.'}</p></div><Link className="btn btn-primary" to="/become-owner">Reapply →</Link></section>;
  return <section className="owner-promotion"><div><h2>Want to List Your Property or Vehicle?</h2><p>Become a verified owner to list your property or vehicle on RentSphere and start receiving rental requests.</p></div><Link className="btn btn-primary" to="/become-owner">Become an Owner →</Link></section>;
}

export function CustomerDashboard() {
  const { user, account } = useContext(AuthContext);
  return <div className="shell dashboard-page"><header className="dashboard-welcome"><span className="eyebrow">User Dashboard</span><h1>Welcome back, {account?.name || user.name} 👋</h1><p>Manage your rental bookings and property visits.</p></header><OwnerApplicationBanner profile={account?.ownerProfile} /><RequestNotifications /><CustomerRequests /><SavedListings key={user.token} /></div>;
}

export default function UserDashboard({ ownerOnly = false }) {
  const { user, account, accountStatus, accountError, refreshAccount } = useContext(AuthContext);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (accountStatus === 'error') return <div className="shell dashboard-retry" role="alert"><p>{accountError || 'Unable to verify your account. Please try again.'}</p><button className="btn btn-primary" onClick={refreshAccount}>Retry account check</button></div>;
  if (accountStatus !== 'ready' || !account) return <div className="shell dashboard-retry" role="status">Verifying your account…</div>;
  const kind = dashboardKind(account);
  if (kind === 'admin') return <Navigate to="/admin" replace />;
  if (ownerOnly && kind !== 'owner') return <Navigate to="/dashboard" replace />;
  return kind === 'owner' ? <OwnerDashboard /> : <CustomerDashboard />;
}

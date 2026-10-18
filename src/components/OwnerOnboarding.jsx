import { useContext, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';

const STEPS = [
  { n: 1, key: 'register', label: 'Owner Registration' },
  { n: 2, key: 'profile', label: 'Owner Profile' },
  { n: 3, key: 'documents', label: 'Verification Details' },
  { n: 4, key: 'review', label: 'Submit Information' },
  { n: 5, key: 'admin', label: 'Admin Review' }
];

const card = { background: '#fff', padding: '30px', borderRadius: '15px', border: '1px solid var(--line)', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' };
const label = { display: 'block', marginBottom: '15px', fontWeight: 'bold' };
const inputStyle = { width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid var(--line)' };
const row = { display: 'flex', gap: '15px', marginBottom: '15px', flexWrap: 'wrap' };
const col = { flex: 1, minWidth: '200px' };

function Stepper({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px', marginBottom: '34px', overflowX: 'auto', paddingBottom: '4px' }}>
      {STEPS.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', flex: i === STEPS.length - 1 ? '0 0 auto' : '1 1 auto', minWidth: '110px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', minWidth: '96px' }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%', display: 'grid', placeItems: 'center',
              fontWeight: 'bold', fontSize: '0.85rem',
              background: s.n < current ? 'var(--green)' : s.n === current ? 'var(--blue)' : '#eef2f7',
              color: s.n <= current ? '#fff' : 'var(--muted)'
            }}>
              {s.n < current ? '✓' : s.n}
            </div>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, textAlign: 'center', color: s.n === current ? 'var(--blue)' : 'var(--muted)' }}>
              Step {s.n}<br />{s.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div style={{ flex: 1, height: '2px', background: s.n < current ? 'var(--green)' : 'var(--line)', margin: '0 4px', marginTop: '-22px' }} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function OwnerOnboarding() {
  const { user, login } = useContext(AuthContext);
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [regForm, setRegForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [profileForm, setProfileForm] = useState({ phone: '', businessName: '', address: '', city: '', state: '', bio: '', listingIntent: 'property' });
  const [docForm, setDocForm] = useState({ idProofType: 'Aadhaar Card', idProofNumber: '' });
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [ownerData, setOwnerData] = useState(null);

  // Resume onboarding progress whenever an owner (or an owner-to-be) is signed in.
  const refreshStatus = async () => {
    if (!user || !user.token) { setLoading(false); return; }
    try {
      const res = await fetch('/api/owner/me', { headers: { Authorization: `Bearer ${user.token}` } });
      if (res.ok) {
        const data = await res.json();
        setOwnerData(data);
        const cs = data.ownerProfile?.currentStep || 1;
        const st = data.ownerProfile?.status;
        setStep(st === 'pending' || st === 'approved' || st === 'rejected' ? 5 : Math.max(cs, 2));
        setProfileForm(f => ({
          ...f,
          phone: data.ownerProfile?.phone || '',
          businessName: data.ownerProfile?.businessName || '',
          address: data.ownerProfile?.address || '',
          city: data.ownerProfile?.city || '',
          state: data.ownerProfile?.state || '',
          bio: data.ownerProfile?.bio || '',
          listingIntent: data.ownerProfile?.listingIntent || 'property'
        }));
      }
    } catch (err) {
      console.warn('Could not load owner status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && user.role === 'admin') { navigate('/admin'); return; }
    if (!user) { setStep(1); setLoading(false); return; }
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ---------- STEP 1: Owner Registration ----------
  const submitRegistration = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!regForm.name.trim()) return setError('Please add your name.');
    if (!/\S+@\S+\.\S+/.test(regForm.email)) return setError('Enter a valid email address.');
    if (regForm.password.length < 6) return setError('Password must be at least 6 characters.');

    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Registration failed.');
      login(data);
      setProfileForm(f => ({ ...f, phone: regForm.phone }));
      setSuccess('Account created! Let’s build your owner profile.');
      setStep(2);
    } catch (err) {
      setError(err.message || 'Could not register right now.');
    } finally {
      setSubmitting(false);
    }
  };

  // Existing logged-in user opting in to become an Owner (skips Step 1)
  const startAsExistingUser = async () => {
    setSubmitting(true); setError('');
    try {
      const res = await fetch('/api/owner/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not start owner onboarding.');
      login({ ...user, role: data.role, token: data.token || user.token });
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- STEP 2: Owner Profile ----------
  const submitProfile = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!profileForm.phone.trim()) return setError('A contact phone number is required.');
    if (!profileForm.address.trim() || !profileForm.city.trim()) return setError('Please add your address and city.');

    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify(profileForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not save profile.');
      setSuccess('Profile saved. Now let’s verify your identity.');
      setStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- STEP 3: Verification details ----------
  const handleFileChange = (e) => {
    const selected = Array.from(e.target.files);
    if (!selected.length) return;
    setFiles(prev => [...prev, ...selected]);
    setPreviews(prev => [...prev, ...selected.map(f => URL.createObjectURL(f))]);
  };
  const removeFile = (i) => {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setPreviews(prev => prev.filter((_, idx) => idx !== i));
  };

  const submitDocuments = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!docForm.idProofNumber.trim()) return setError('Please enter your ID proof number.');

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('idProofType', docForm.idProofType);
      formData.append('idProofNumber', docForm.idProofNumber);
      files.forEach(f => formData.append('documents', f));

      const res = await fetch('/api/owner/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not upload verification details.');
      setOwnerData(prev => ({ ...(prev || {}), ownerProfile: data.ownerProfile }));
      setSuccess('Details saved. Review everything before you submit.');
      setStep(4);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- STEP 4: Owner submits information for Admin review ----------
  const finalSubmit = async () => {
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/owner/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not submit application.');
      setOwnerData(prev => ({ ...(prev || {}), ownerProfile: data.ownerProfile }));
      setSuccess('Application submitted! An admin will review it shortly.');
      setStep(5);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="shell" style={{ padding: '100px 0', textAlign: 'center', color: 'var(--muted)' }}>Loading onboarding…</div>;
  }

  const status = ownerData?.ownerProfile?.status;

  return (
    <div className="shell" style={{ padding: '60px 0 100px', maxWidth: '820px', margin: '0 auto' }}>
      <div style={{ marginBottom: '30px' }}>
        <span className="eyebrow">Owner Onboarding</span>
        <h1 style={{ margin: '6px 0 8px' }}>Become a RentSphere Owner</h1>
        <p style={{ color: 'var(--muted)' }}>List your properties and vehicles once your application is verified by our admin team.</p>
      </div>

      <Stepper current={step} />

      {error && <p className="form-error" style={{ marginBottom: '18px' }}>{error}</p>}
      {success && <p className="form-success" style={{ marginBottom: '18px' }}>✓ {success}</p>}

      {/* STEP 1 */}
      {step === 1 && (
        <div style={card}>
          <h2>Step 1 — Owner Registration</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
            Create your RentSphere owner account to get started.
          </p>

          {user ? (
            <div>
              <p style={{ marginBottom: '16px' }}>You’re signed in as <strong>{user.name}</strong> ({user.email}). Continue to start your owner application with this account.</p>
              <button className="btn btn-primary" disabled={submitting} onClick={startAsExistingUser}>
                {submitting ? 'Starting…' : 'Continue as this account →'}
              </button>
            </div>
          ) : (
            <form onSubmit={submitRegistration}>
              <label style={label}>Full name
                <input style={inputStyle} value={regForm.name} onChange={e => setRegForm({ ...regForm, name: e.target.value })} placeholder="Your full name" />
              </label>
              <div style={row}>
                <label style={{ ...label, ...col }}>Email address
                  <input style={inputStyle} type="email" value={regForm.email} onChange={e => setRegForm({ ...regForm, email: e.target.value })} placeholder="you@example.com" />
                </label>
                <label style={{ ...label, ...col }}>Phone number
                  <input style={inputStyle} value={regForm.phone} onChange={e => setRegForm({ ...regForm, phone: e.target.value })} placeholder="+91 ..." />
                </label>
              </div>
              <label style={label}>Password
                <input style={inputStyle} type="password" value={regForm.password} onChange={e => setRegForm({ ...regForm, password: e.target.value })} placeholder="At least 6 characters" />
              </label>
              <button className="btn btn-primary full" disabled={submitting}>{submitting ? 'Creating account...' : 'Register as Owner →'}</button>
              <p className="auth-switch" style={{ marginTop: '16px' }}>Already have an account? <Link to="/login">Log in</Link>, then return here.</p>
            </form>
          )}
        </div>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <div style={card}>
          <h2>Step 2 — Owner Profile</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
            Tell us more about you so renters and our admin team know who they’re working with.
          </p>
          <form onSubmit={submitProfile}>
            <div style={row}>
              <label style={{ ...label, ...col }}>Contact phone
                <input style={inputStyle} value={profileForm.phone} onChange={e => setProfileForm({ ...profileForm, phone: e.target.value })} placeholder="+91 ..." />
              </label>
              <label style={{ ...label, ...col }}>Business name (optional)
                <input style={inputStyle} value={profileForm.businessName} onChange={e => setProfileForm({ ...profileForm, businessName: e.target.value })} placeholder="e.g. Shaikh Rentals" />
              </label>
            </div>
            <label style={label}>Address
              <input style={inputStyle} value={profileForm.address} onChange={e => setProfileForm({ ...profileForm, address: e.target.value })} placeholder="Street / area" />
            </label>
            <div style={row}>
              <label style={{ ...label, ...col }}>City
                <input style={inputStyle} value={profileForm.city} onChange={e => setProfileForm({ ...profileForm, city: e.target.value })} placeholder="City" />
              </label>
              <label style={{ ...label, ...col }}>State
                <input style={inputStyle} value={profileForm.state} onChange={e => setProfileForm({ ...profileForm, state: e.target.value })} placeholder="State" />
              </label>
            </div>
            <label style={label}>What do you plan to list?
              <select style={inputStyle} value={profileForm.listingIntent} onChange={e => setProfileForm({ ...profileForm, listingIntent: e.target.value })}>
                <option value="property">Properties / Rooms</option>
                <option value="vehicle">Vehicles</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label style={label}>Short bio
              <textarea style={{ ...inputStyle, resize: 'vertical' }} rows="3" value={profileForm.bio} onChange={e => setProfileForm({ ...profileForm, bio: e.target.value })} placeholder="A little about you or your rental business..." />
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : 'Save & continue →'}</button>
            </div>
          </form>
        </div>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <div style={card}>
          <h2>Step 3 — Verification Details</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
            Add an ID proof so our admin team can verify your identity before approving your listings.
          </p>
          <form onSubmit={submitDocuments}>
            <div style={row}>
              <label style={{ ...label, ...col }}>ID proof type
                <select style={inputStyle} value={docForm.idProofType} onChange={e => setDocForm({ ...docForm, idProofType: e.target.value })}>
                  <option>Aadhaar Card</option>
                  <option>PAN Card</option>
                  <option>Passport</option>
                  <option>Driving License</option>
                </select>
              </label>
              <label style={{ ...label, ...col }}>ID proof number
                <input style={inputStyle} value={docForm.idProofNumber} onChange={e => setDocForm({ ...docForm, idProofNumber: e.target.value })} placeholder="ID number" />
              </label>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Upload ID proof / supporting documents</label>
              <input type="file" accept="image/*,application/pdf" multiple onChange={handleFileChange}
                style={{ width: '100%', padding: '8px', border: '1px dashed var(--line)', borderRadius: '8px', background: '#fafafa', cursor: 'pointer' }} />
              {previews.length > 0 && (
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '15px' }}>
                  {previews.map((src, i) => (
                    <div key={i} style={{ position: 'relative', width: '70px', height: '70px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--line)' }}>
                      <img src={src} alt={`Doc ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button type="button" onClick={() => removeFile(i)} title="Remove"
                        style={{ position: 'absolute', top: '2px', right: '2px', background: 'rgba(0,0,0,0.7)', color: '#fff', border: 'none', borderRadius: '50%', width: '18px', height: '18px', fontSize: '10px', cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} onClick={() => setStep(2)}>← Back</button>
              <button className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : 'Save & continue →'}</button>
            </div>
          </form>
        </div>
      )}

      {/* STEP 4 */}
      {step === 4 && (
        <div style={card}>
          <h2>Step 4 — Owner Submits Information</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
            Review everything below, then submit your application for admin approval.
          </p>

          <div style={{ display: 'grid', gap: '10px', fontSize: '0.9rem', marginBottom: '22px' }}>
            <div><strong>Phone:</strong> {profileForm.phone || '—'}</div>
            <div><strong>Business name:</strong> {profileForm.businessName || '—'}</div>
            <div><strong>Address:</strong> {profileForm.address || '—'}, {profileForm.city || '—'} {profileForm.state}</div>
            <div><strong>Plans to list:</strong> {profileForm.listingIntent}</div>
            <div><strong>ID proof:</strong> {docForm.idProofType} · {docForm.idProofNumber || '—'}</div>
            <div><strong>Documents uploaded:</strong> {(ownerData?.ownerProfile?.documents?.length || files.length) || 0}</div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} onClick={() => setStep(3)}>← Back</button>
            <button className="btn btn-primary" disabled={submitting} onClick={finalSubmit}>
              {submitting ? 'Submitting...' : 'Submit for Admin Review →'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 5 */}
      {step === 5 && (
        <div style={card}>
          <h2>Step 5 — Admin Review</h2>

          {status === 'approved' ? (
            <div>
              <div style={{ background: '#e0f7ec', color: 'var(--green)', padding: '16px', borderRadius: '10px', fontWeight: 'bold', marginBottom: '16px' }}>
                ✓ You’re a verified RentSphere Owner!
              </div>
              <p style={{ color: 'var(--muted)', marginBottom: '18px' }}>Your application was approved. You can now publish properties and vehicles from your dashboard.</p>
              <Link className="btn btn-primary" to="/dashboard">Go to my dashboard →</Link>
            </div>
          ) : status === 'rejected' ? (
            <div>
              <div style={{ background: '#fff5f5', color: '#c53030', padding: '16px', borderRadius: '10px', fontWeight: 'bold', marginBottom: '10px' }}>
                Your application was not approved.
              </div>
              {ownerData?.ownerProfile?.reviewNote && (
                <p style={{ color: 'var(--muted)', marginBottom: '18px' }}><strong>Admin note:</strong> {ownerData.ownerProfile.reviewNote}</p>
              )}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} onClick={() => setStep(2)}>Edit application</button>
                <button className="btn btn-primary" onClick={refreshStatus}>Refresh status</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ background: '#fff8e6', color: '#a15c00', padding: '16px', borderRadius: '10px', fontWeight: 'bold', marginBottom: '16px' }}>
                ⏳ Pending admin review
              </div>
              <p style={{ color: 'var(--muted)', marginBottom: '18px' }}>
                Thanks for submitting your details! Our admin team reviews new owner applications shortly. You’ll be able to list properties and vehicles once approved.
              </p>
              <button className="btn btn-primary" onClick={refreshStatus}>Check status →</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

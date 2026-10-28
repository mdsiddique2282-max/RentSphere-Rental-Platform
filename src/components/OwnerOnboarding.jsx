import { ownerProfileErrors, ownerDocumentErrors, ownerFileError, validOwnerPhone } from '../data/ownerPolicy';
import { useContext, useEffect, useRef, useState } from 'react';
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

export function Stepper({ current, completed = 1, onSelect, disabled = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px', marginBottom: '34px', overflowX: 'auto', paddingBottom: '4px' }}>
      {STEPS.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', flex: i === STEPS.length - 1 ? '0 0 auto' : '1 1 auto', minWidth: '110px' }}>
          <button type="button" disabled={disabled || s.n === current || s.n >= completed} aria-current={s.n === current ? 'step' : undefined} onClick={() => { if (!disabled && s.n !== current && s.n < completed) onSelect?.(s.n); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', minWidth: '96px', border: 0, padding: 0, background: 'transparent', font: 'inherit' }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%', display: 'grid', placeItems: 'center',
              fontWeight: 'bold', fontSize: '0.85rem',
              background: s.n !== current && s.n < completed ? 'var(--green)' : s.n === current ? 'var(--blue)' : '#eef2f7',
              color: s.n === current || s.n < completed ? '#fff' : 'var(--muted)'
            }}>
              {s.n !== current && s.n < completed ? '✓' : s.n}
            </div>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, textAlign: 'center', color: s.n === current ? 'var(--blue)' : 'var(--muted)' }}>
              Step {s.n}<br />{s.label}
            </span>
          </button>
          {i < STEPS.length - 1 && (
            <div style={{ flex: 1, height: '2px', background: s.n < completed ? 'var(--green)' : 'var(--line)', margin: '0 4px', marginTop: '-22px' }} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function OwnerOnboarding() {
  const { user, login, refreshAccount } = useContext(AuthContext);
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [regForm, setRegForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [profileForm, setProfileForm] = useState({ phone: '', businessName: '', address: '', city: '', state: '', bio: '', listingIntent: '' });
  const [docForm, setDocForm] = useState({ idProofType: 'Aadhaar Card', idProofNumber: '' });
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [ownerData, setOwnerData] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({}), [completed, setCompleted] = useState(1);
  const root = useRef(), previewRefs = useRef([]);
  const statusSequence = useRef(0);
  const status = ownerData?.ownerProfile?.status;
  const readOnly = ['pending', 'approved'].includes(status);
  const showErrors = errors => {
    setFieldErrors(errors);
    const key = Object.keys(errors)[0];
    if (key) requestAnimationFrame(() => { const field = root.current?.querySelector('[name="' + key + '"]'); field?.focus(); field?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); });
    return Boolean(key);
  };
  const clearField = key => setFieldErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
  const fieldError = key => fieldErrors[key] && <small id={'owner-error-' + key} className="form-error" role="alert" style={{ display: 'block', marginTop: 5 }}>{fieldErrors[key]}</small>;
  const fieldProps = key => ({ name: key, 'aria-invalid': Boolean(fieldErrors[key]), 'aria-describedby': fieldErrors[key] ? 'owner-error-' + key : undefined });
  useEffect(() => () => previewRefs.current.forEach(url => URL.revokeObjectURL(url)), []);

  // Resume onboarding progress whenever an owner (or an owner-to-be) is signed in.
  const refreshStatus = async () => {
    if (!user || !user.token) { setLoading(false); return; }
    const sequence = ++statusSequence.current;
    try {
      const res = await fetch('/api/owner/me', { headers: { Authorization: `Bearer ${user.token}` }, cache: 'no-store' });
      if (sequence !== statusSequence.current) return;
      if (!res.ok) throw new Error('Unable to load your application. Please retry.');
      if (res.ok) {
        const data = await res.json();
        if (sequence !== statusSequence.current) return;
        setOwnerData(data);
        const cs = data.ownerProfile?.currentStep || 1;
        const st = data.ownerProfile?.status;
        const submitted = ['pending', 'approved', 'rejected', 'revoked'].includes(st);
        const draftStep = Math.min(Math.max(cs, 2), 4);
        setCompleted(submitted ? 5 : draftStep);
        setRegForm(f => ({ ...f, name: data.name || '', email: data.email || '', phone: data.ownerProfile?.phone || '' }));
        setDocForm({ idProofType: data.ownerProfile?.idProofType || 'Aadhaar Card', idProofNumber: data.ownerProfile?.idProofNumber || '' });
        setStep(submitted ? 5 : draftStep);
        setProfileForm(f => ({
          ...f,
          phone: data.ownerProfile?.phone || '',
          businessName: data.ownerProfile?.businessName || '',
          address: data.ownerProfile?.address || '',
          city: data.ownerProfile?.city || '',
          state: data.ownerProfile?.state || '',
          bio: data.ownerProfile?.bio || '',
          listingIntent: data.ownerProfile?.listingIntent || ''
        }));
      }
    } catch (err) {
      if (sequence === statusSequence.current) setError(err.message || 'Unable to load your application. Please retry.');
    } finally {
      if (sequence === statusSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (user && user.role === 'admin') { navigate('/admin'); return; }
    if (!user) { setStep(1); setLoading(false); return; }
    refreshStatus();
    return () => { ++statusSequence.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.token]);

  useEffect(() => { if (ownerData?.ownerProfile?.status) refreshAccount?.(); }, [ownerData?.ownerProfile?.status, refreshAccount]);

  // ---------- STEP 1: Owner Registration ----------
  const submitRegistration = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    const errors = {};
    if (!regForm.name.trim()) errors.name = 'Please add your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regForm.email.trim())) errors.email = 'Enter a valid email address.';
    if (!validOwnerPhone(regForm.phone)) errors.phone = 'Please enter a valid 10-digit Indian mobile number.';
    if (regForm.password.length < 6 || new TextEncoder().encode(regForm.password).length > 72) errors.password = 'Password must be at least 6 characters and at most 72 UTF-8 bytes.';
    if (showErrors(errors)) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regForm)
      });
      const data = await res.json();
      if (!res.ok) { if (data.errors) showErrors(data.errors); throw new Error(data?.message || 'Registration failed.'); }
      setOwnerData(data); setCompleted(2);
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
    if (readOnly) { setStep(2); return; }
    ++statusSequence.current;
    setSubmitting(true); setError('');
    try {
      const res = await fetch('/api/owner/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      const data = await res.json();
      if (!res.ok) { if (data.errors) showErrors(data.errors); throw new Error(data?.message || 'Could not start owner onboarding.'); }
      setOwnerData(data); setCompleted(Math.max(data.ownerProfile?.currentStep || 2, 2));
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
    if (readOnly || showErrors(ownerProfileErrors(profileForm))) return;
    ++statusSequence.current;

    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify(profileForm)
      });
      const data = await res.json();
      if (!res.ok) { if (data.errors) showErrors(data.errors); throw new Error(data?.message || 'Could not save profile.'); }
      setOwnerData(prev => ({ ...prev, ownerProfile: data.ownerProfile })); setCompleted(previous => Math.max(previous, 3));
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
    const invalid = ownerFileError([...files, ...selected]);
    if (invalid) { showErrors({ documents: invalid }); e.target.value = ''; return; }
    clearField('documents'); setFiles(prev => [...prev, ...selected]);
    const urls = selected.map(file => URL.createObjectURL(file)); previewRefs.current.push(...urls);
    setPreviews(prev => [...prev, ...urls]);
  };
  const removeFile = (i) => {
    URL.revokeObjectURL(previews[i]);
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setPreviews(prev => prev.filter((_, idx) => idx !== i));
  };

  const submitDocuments = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (readOnly || showErrors({ ...ownerDocumentErrors(docForm, [...(ownerData?.ownerProfile?.documents || []), ...files]), ...(ownerFileError(files) ? { documents: ownerFileError(files) } : {}) })) return;
    ++statusSequence.current;

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
      if (!res.ok) { if (data.errors) showErrors(data.errors); throw new Error(data?.message || 'Could not upload verification details.'); }
      setOwnerData(prev => ({ ...(prev || {}), ownerProfile: data.ownerProfile }));
      previewRefs.current.forEach(url => URL.revokeObjectURL(url)); previewRefs.current = []; setFiles([]); setPreviews([]); setCompleted(previous => Math.max(previous, 4));
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
    if (readOnly) { setError('This application is already submitted or approved. Review its current status below.'); setStep(5); return; }
    const errors = { ...ownerProfileErrors(profileForm), ...ownerDocumentErrors(docForm, ownerData?.ownerProfile?.documents || []) };
    if (Object.keys(errors).length) { setStep(Object.keys(ownerProfileErrors(profileForm)).length ? 2 : 3); showErrors(errors); return; }
    ++statusSequence.current;
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/owner/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` }
      });
      const data = await res.json();
      if (!res.ok) { if (data.errors) showErrors(data.errors); throw new Error(data?.message || 'Could not submit application.'); }
      setOwnerData(prev => ({ ...(prev || {}), ownerProfile: data.ownerProfile }));
      setCompleted(5);
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

  return (
    <div ref={root} className="shell" style={{ padding: '60px 0 100px', maxWidth: '820px', margin: '0 auto' }}>
      <div style={{ marginBottom: '30px' }}>
        <span className="eyebrow">Owner Onboarding</span>
        <h1 style={{ margin: '6px 0 8px' }}>Become a RentSphere Owner</h1>
        <p style={{ color: 'var(--muted)' }}>List your properties and vehicles once your application is verified by our admin team.</p>
      </div>

      <Stepper current={step} completed={completed} disabled={submitting} onSelect={value => { setStep(value); setFieldErrors({}); setError(''); }} />
      {readOnly && <p role="status">Your application is {status === 'pending' ? 'awaiting admin review' : 'approved'}. Submitted information is view-only.</p>}

      {error && <p role="alert" className="form-error" style={{ marginBottom: '18px' }}>{error}</p>}
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
            <form noValidate onSubmit={submitRegistration}>
              <label style={label}>Full name
                <input style={inputStyle} {...fieldProps('name')} value={regForm.name} onChange={e => { clearField('name'); setRegForm({ ...regForm, name: e.target.value }); }} placeholder="Your full name" />{fieldError('name')}
              </label>
              <div style={row}>
                <label style={{ ...label, ...col }}>Email address
                  <input style={inputStyle} type="email" {...fieldProps('email')} value={regForm.email} onChange={e => { clearField('email'); setRegForm({ ...regForm, email: e.target.value }); }} placeholder="you@example.com" />{fieldError('email')}
                </label>
                <label style={{ ...label, ...col }}>Phone number
                  <input style={inputStyle} {...fieldProps('phone')} value={regForm.phone} onChange={e => { clearField('phone'); setRegForm({ ...regForm, phone: e.target.value }); }} placeholder="+91 ..." />{fieldError('phone')}
                </label>
              </div>
              <label style={label}>Password
                <input style={inputStyle} type="password" {...fieldProps('password')} value={regForm.password} onChange={e => { clearField('password'); setRegForm({ ...regForm, password: e.target.value }); }} placeholder="At least 6 characters" />{fieldError('password')}
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
          <form noValidate onSubmit={submitProfile}><fieldset disabled={readOnly || submitting} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <div style={row}>
              <label style={{ ...label, ...col }}>Contact phone
                <input style={inputStyle} {...fieldProps('phone')} value={profileForm.phone} onChange={e => { clearField('phone'); setProfileForm({ ...profileForm, phone: e.target.value }); }} placeholder="+91 ..." />{fieldError('phone')}
              </label>
              <label style={{ ...label, ...col }}>Business name (optional)
                <input style={inputStyle} {...fieldProps('businessName')} value={profileForm.businessName} onChange={e => { clearField('businessName'); setProfileForm({ ...profileForm, businessName: e.target.value }); }} placeholder="e.g. Shaikh Rentals" />{fieldError('businessName')}
              </label>
            </div>
            <label style={label}>Address
              <input style={inputStyle} {...fieldProps('address')} value={profileForm.address} onChange={e => { clearField('address'); setProfileForm({ ...profileForm, address: e.target.value }); }} placeholder="Enter your complete address" />{fieldError('address')}
            </label>
            <div style={row}>
              <label style={{ ...label, ...col }}>City
                <input style={inputStyle} {...fieldProps('city')} value={profileForm.city} onChange={e => { clearField('city'); setProfileForm({ ...profileForm, city: e.target.value }); }} placeholder="City" />{fieldError('city')}
              </label>
              <label style={{ ...label, ...col }}>State
                <input style={inputStyle} {...fieldProps('state')} value={profileForm.state} onChange={e => { clearField('state'); setProfileForm({ ...profileForm, state: e.target.value }); }} placeholder="State" />{fieldError('state')}
              </label>
            </div>
            <label style={label}>What do you plan to list?
              <select style={inputStyle} {...fieldProps('listingIntent')} value={profileForm.listingIntent} onChange={e => { clearField('listingIntent'); setProfileForm({ ...profileForm, listingIntent: e.target.value }); }}>
                <option value="">Choose…</option>
                {profileForm.listingIntent && !['property','vehicle','both'].includes(profileForm.listingIntent) && <option value={profileForm.listingIntent}>{profileForm.listingIntent}</option>}
                <option value="property">Properties / Rooms</option>
                <option value="vehicle">Vehicles</option>
                <option value="both">Both</option>
              </select>{fieldError('listingIntent')}
            </label>
            <label style={label}>Short bio
              <textarea style={{ ...inputStyle, resize: 'vertical' }} rows="3" {...fieldProps('bio')} value={profileForm.bio} onChange={e => { clearField('bio'); setProfileForm({ ...profileForm, bio: e.target.value }); }} placeholder="A little about you or your rental business..." />{fieldError('bio')}
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving...' : 'Save & continue →'}</button>
            </div>
          </fieldset>{readOnly && <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Continue →</button>}</form>
        </div>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <div style={card}>
          <h2>Step 3 — Verification Details</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '20px' }}>
            Add an ID proof so our admin team can verify your identity before approving your listings.
          </p>
          <form noValidate onSubmit={submitDocuments}><fieldset disabled={readOnly || submitting} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <div style={row}>
              <label style={{ ...label, ...col }}>ID proof type
                <select style={inputStyle} {...fieldProps('idProofType')} value={docForm.idProofType} onChange={e => { clearField('idProofType'); setDocForm({ ...docForm, idProofType: e.target.value }); }}>
                  <option>Aadhaar Card</option>
                  <option>PAN Card</option>
                  <option>Passport</option>
                  <option>Driving License</option>
                </select>{fieldError('idProofType')}
              </label>
              <label style={{ ...label, ...col }}>ID proof number
                <input style={inputStyle} {...fieldProps('idProofNumber')} value={docForm.idProofNumber} onChange={e => { clearField('idProofNumber'); setDocForm({ ...docForm, idProofNumber: e.target.value }); }} placeholder="ID number" />{fieldError('idProofNumber')}
              </label>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Upload ID proof / supporting documents</label>
              <input {...fieldProps('documents')} type="file" disabled={readOnly} accept="image/*,application/pdf" multiple onChange={handleFileChange}
                style={{ width: '100%', padding: '8px', border: '1px dashed var(--line)', borderRadius: '8px', background: '#fafafa', cursor: 'pointer' }} />
              {fieldError('documents')}
              {ownerData?.ownerProfile?.documents?.map((_, index) => <p key={index}>Saved verification document {index + 1}</p>)}
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
          </fieldset>{readOnly && <button type="button" className="btn btn-primary" onClick={() => setStep(4)}>Continue →</button>}</form>
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
            <button className="btn btn-primary" disabled={submitting} onClick={readOnly ? () => setStep(5) : finalSubmit}>
              {readOnly ? 'Return to Admin Review →' : submitting ? 'Submitting...' : 'Submit for Admin Review →'}
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
          ) : status === 'rejected' || status === 'revoked' ? (
            <div>
              <div style={{ background: '#fff5f5', color: '#c53030', padding: '16px', borderRadius: '10px', fontWeight: 'bold', marginBottom: '10px' }}>
                {status === 'revoked' ? 'Your owner access has been revoked.' : 'Your application was not approved.'}
              </div>
              {ownerData?.ownerProfile?.reviewNote && (
                <p style={{ color: 'var(--muted)', marginBottom: '18px' }}><strong>Admin note:</strong> {ownerData.ownerProfile.reviewNote}</p>
              )}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn" style={{ background: '#f0f4fb', color: 'var(--ink)' }} disabled={submitting} onClick={status === 'revoked' ? startAsExistingUser : () => setStep(2)}>Edit application</button>
                <button className="btn btn-primary" onClick={refreshStatus}>Refresh status</button>
              </div>
            </div>
          ) : status === 'pending' ? (
            <div>
              <div style={{ background: '#fff8e6', color: '#a15c00', padding: '16px', borderRadius: '10px', fontWeight: 'bold', marginBottom: '16px' }}>
                ⏳ Pending admin review
              </div>
              <p style={{ color: 'var(--muted)', marginBottom: '18px' }}>
                Thanks for submitting your details! Our admin team reviews new owner applications shortly. You’ll be able to list properties and vehicles once approved.
              </p>
              <button className="btn btn-primary" onClick={refreshStatus}>Check status →</button>
            </div>
          ) : <div><p>Your application has not been submitted. Complete and review your information before submitting.</p><button className="btn btn-primary" onClick={() => setStep(2)}>Continue application →</button></div>}
        </div>
      )}
    </div>
  );
}

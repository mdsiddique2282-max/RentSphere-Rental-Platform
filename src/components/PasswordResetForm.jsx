import { useContext, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { notifyToast } from '../data/toasts';

export default function PasswordResetForm({ reset = false }) {
  const location = useLocation();
  const { logout } = useContext(AuthContext);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const token = location.hash.slice(1);
  const submit = async event => {
    event.preventDefault(); if (busy) return; setError(''); setMessage('');
    if (reset && (password !== confirmation || password.trim().length === 0 || password.length < 6 || new TextEncoder().encode(password).length > 72)) {
      setError('Enter matching passwords with at least 6 characters and at most 72 UTF-8 bytes.'); return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/' + (reset ? 'reset-password' : 'forgot-password'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reset ? { token, password } : { email }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Unable to process your request.');
      setMessage(data.message); notifyToast(reset ? 'Password updated successfully!' : 'Reset request received.', 'success');
      if (reset) { setPassword(''); setConfirmation(''); logout(); }
    } catch (e) { setError(e.message || 'Unable to process your request. Please try again.'); notifyToast(e.message || 'Unable to process your request.', 'error'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-panel"><Link to="/" className="logo">Rent<span>Sphere</span></Link><span className="eyebrow">Your rental world, in one place</span>
    <h1>{reset ? 'Choose a new password' : 'Forgot your password?'}</h1><p>{reset ? 'Use the secure link from your reset email.' : 'Enter your account email to request a reset link.'}</p>
    {reset && !/^[a-f\d]{64}$/i.test(token) ? <p className="form-error">Invalid reset link. Request a new email below.</p> : <form onSubmit={submit}>
      {reset ? <><label>New password<input type="password" autoComplete="new-password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)} /></label><label>Confirm password<input type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label></> : <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
      <button className="btn btn-primary full" disabled={busy || (reset && Boolean(message))}>{busy ? 'Please wait…' : reset ? 'Update password' : 'Send reset email'}</button>
    </form>}
    <p className="auth-switch"><Link to="/login">Back to login</Link>{reset && <> · <Link to="/forgot-password">Request a new reset link</Link></>}</p>
  </section><aside className="auth-aside"><p>“The right home and the right ride should feel equally effortless.”</p></aside></main>;
}

import { useState, useContext, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { submitAuthentication } from '../data/authentication';
import { notifyToast } from '../data/toasts';
import { requestReturnPath } from '../data/requests';

export default function AuthForm({ register=false }) { 
  const [show, setShow] = useState(false); 
  const [values,setValues] = useState({name:'',email:'',password:''}); 
  const [error,setError] = useState(''); 
  const [success,setSuccess] = useState(''); 
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const navigate = useNavigate(); 
  const location = useLocation();
  const { login } = useContext(AuthContext);

  const update=e=>setValues({...values,[e.target.name]:e.target.value}); 
  const submit=async e=>{
    e.preventDefault(); 
    if (inFlight.current) return;
    inFlight.current = true; setSubmitting(true); setError(''); setSuccess('');
    try {
      const destination = !register && requestReturnPath(new URLSearchParams(location.search).get('returnTo'));
      const result = await submitAuthentication({ values, register, login, navigate: path => navigate(destination || path), notify: notifyToast });
      if (result.error) setError(result.error);
      if (result.success) setSuccess(result.success);
    } finally { inFlight.current = false; setSubmitting(false); }
  }; 
  
  return <main className="auth-page"><section className="auth-panel"><Link to="/" className="logo">Rent<span>Sphere</span></Link><span className="eyebrow">Your rental world, in one place</span><h1>{register?'Create your account':'Welcome back'}</h1><p>{register?'Save favourites and keep every rental request in one place.':'Sign in to continue your rental journey.'}</p><form onSubmit={submit} noValidate>{register&&<label>Full name<input name="name" value={values.name} onChange={update} placeholder="Your full name"/></label>}<label>Email address<input name="email" type="email" value={values.email} onChange={update} placeholder="you@example.com"/></label><label>Password<div className="password-wrap"><input name="password" type={show?'text':'password'} value={values.password} onChange={update} placeholder="At least 6 characters"/><button type="button" onClick={()=>setShow(!show)}>{show?'Hide':'Show'}</button></div></label>{error&&<p className="form-error">{error}</p>}{success&&<p className="form-success">{success}</p>}<button className="btn btn-primary full" disabled={submitting} aria-busy={submitting}>{register?'Create account':'Log in'} →</button></form>{!register && <p><Link className="text-link" to="/forgot-password">Forgot Password?</Link></p>}<p className="auth-switch">{register?'Already have an account?':'New to RentSphere?'} <Link to={register?'/login':'/register'}>{register?'Log in':'Create an account'}</Link></p></section><aside className="auth-aside"><p>“The right home and the right ride should feel equally effortless.”</p><div><strong>500+</strong> verified spaces · <strong>200+</strong> ready rides</div></aside></main>;
}

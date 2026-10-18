import { useState, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';

export default function AuthForm({ register=false }) { 
  const [show, setShow] = useState(false); 
  const [values,setValues] = useState({name:'',email:'',password:''}); 
  const [error,setError] = useState(''); 
  const [success,setSuccess] = useState(''); 
  const navigate = useNavigate(); 
  const { login } = useContext(AuthContext);

  const update=e=>setValues({...values,[e.target.name]:e.target.value}); 
  const submit=async e=>{
    e.preventDefault(); 
    if(register && !values.name.trim()) return setError('Please add your name.'); 
    if(!/\S+@\S+\.\S+/.test(values.email)) return setError('Enter a valid email address.'); 
    if(values.password.length<6) return setError('Password must be at least 6 characters.'); 
    setError(''); 
    
    try {
      const endpoint = register ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      let data;
      try {
        data = await res.json();
      } catch (jsonErr) {
        // If it's a 504 Gateway Timeout or similar from Vite proxy (empty response)
        throw new Error('Database or backend server is not reachable right now.');
      }
      
      if (!res.ok) throw new Error(data?.message || 'Authentication failed');
      
      login(data);
      setSuccess(register ? 'Account created. Welcome to RentSphere!' : 'Login successful. Welcome back!'); 
      navigate(data.role === 'admin' ? '/admin' : '/dashboard');
    } catch(err) {
      // A failed login/registration must never create a session.
      setError(err.message || 'Something went wrong. Please try again.');
    }
  }; 
  
  return <main className="auth-page"><section className="auth-panel"><Link to="/" className="logo">Rent<span>Sphere</span></Link><span className="eyebrow">Your rental world, in one place</span><h1>{register?'Create your account':'Welcome back'}</h1><p>{register?'Save favourites and keep every rental request in one place.':'Sign in to continue your rental journey.'}</p><form onSubmit={submit} noValidate>{register&&<label>Full name<input name="name" value={values.name} onChange={update} placeholder="Your full name"/></label>}<label>Email address<input name="email" type="email" value={values.email} onChange={update} placeholder="you@example.com"/></label><label>Password<div className="password-wrap"><input name="password" type={show?'text':'password'} value={values.password} onChange={update} placeholder="At least 6 characters"/><button type="button" onClick={()=>setShow(!show)}>{show?'Hide':'Show'}</button></div></label>{error&&<p className="form-error">{error}</p>}{success&&<p className="form-success">{success}</p>}<button className="btn btn-primary full">{register?'Create account':'Log in'} →</button></form><p className="auth-switch">{register?'Already have an account?':'New to RentSphere?'} <Link to={register?'/login':'/register'}>{register?'Log in':'Create an account'}</Link></p></section><aside className="auth-aside"><p>“The right home and the right ride should feel equally effortless.”</p><div><strong>500+</strong> verified spaces · <strong>200+</strong> ready rides</div></aside></main>; 
}

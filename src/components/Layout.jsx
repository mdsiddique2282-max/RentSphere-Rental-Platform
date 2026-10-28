import './Layout.css';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useState, useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { dashboardKind } from '../data/account';

export function Navbar() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { user, logout, account, accountStatus } = useContext(AuthContext);
  // Account is verified in this session by AuthProvider, never copied from
  // localStorage. Retain its navigation label during a transient refresh error.
  const kind = account ? dashboardKind(account) : null;

  return <header className="site-header"><nav className="nav shell" aria-label="Main navigation">
    <Link className="logo" to="/" onClick={close}>Rent<span>Sphere</span></Link>
    <button className={`menu-toggle ${open ? 'is-open' : ''}`} aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen(!open)}><span className="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span><span className="menu-label">MENU</span></button>
    <div className={`nav-links ${open ? 'is-open' : ''}`}>
      <NavLink to="/" onClick={close}>Home</NavLink>
      <NavLink to="/properties" onClick={close}>Properties</NavLink>
      <NavLink to="/vehicles" onClick={close}>Vehicles</NavLink>
      <NavLink to="/about" onClick={close}>About</NavLink>
      <NavLink to="/contact" onClick={close}>Contact</NavLink>
      {(!user || kind === 'user') && (
        <NavLink to="/become-owner" onClick={close} style={{fontWeight: '700'}}>Become an Owner</NavLink>
      )}
      {user ? (
        <>
          <NavLink to={kind === 'admin' ? '/admin' : kind === 'owner' ? '/owner-dashboard' : '/dashboard'} onClick={close} style={{fontWeight: '700', color: 'var(--blue)'}}>
            {kind === 'admin' ? 'Admin Dashboard' : kind === 'owner' ? 'Owner Dashboard' : kind === 'user' ? 'User Dashboard' : 'Dashboard'}
          </NavLink>
          <button className="nav-login" onClick={() => { logout(); close(); }} style={{border: 'none', font: 'inherit', cursor: 'pointer'}}>Log out</button>
        </>
      ) : (
        <NavLink className="nav-login" to="/login" onClick={close}>Log in</NavLink>
      )}
    </div>
  </nav></header>;
}

export function Footer({ mediaCredits = [] }) { const { pathname } = useLocation(); const cityBase = pathname.startsWith('/vehicles') ? '/vehicles' : '/properties'; const cityLink = city => <Link to={`${cityBase}?city=${city}`} style={{display: 'inline', margin: 0}}>{city}</Link>; return <footer id="contact" className="footer"><div className="shell footer-grid"><div><Link className="logo" to="/">Rent<span>Sphere</span></Link><p>One thoughtful place to find a home or a ride that fits the way you live.</p></div><div><h4>Explore</h4><Link to="/properties">Rental homes</Link><Link to="/vehicles">Cars & bikes</Link><a href="/#about">How it works</a></div><div><h4>Contact</h4><a href="mailto:mnshaikh2208@gmail.com">mnshaikh2208@gmail.com</a><span>+91 9403570134</span><span>+91 9209294848</span><span>{cityLink('Mumbai')}</span></div></div>{mediaCredits?.length > 0 && <small className="shell site-image-credits" aria-label="Image attribution">Image credits: {mediaCredits.map((credit, index) => <span key={credit.sha256 || index}>{index > 0 ? ' · ' : ''}<a href={credit.sourcePage} title={credit.attribution || credit.angle} target="_blank" rel="noreferrer">{credit.author}</a>{' '}<a href={credit.licenseUrl} target="_blank" rel="noreferrer">{credit.license}</a></span>)}</small>}<div className="shell footer-bottom">© 2026 RentSphere · College project demo — no real payments are processed.</div></footer>; }

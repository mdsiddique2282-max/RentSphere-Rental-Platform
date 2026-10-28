import { createContext, useState, useEffect, useCallback, useRef } from 'react';
import { fetchCurrentAccount, accountRefreshFailure } from '../data/account';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('rentsphere-user'));
      if (parsed && parsed.token && parsed.token !== 'dummy-token' && parsed._id !== 'dummy') return parsed;
      localStorage.removeItem('rentsphere-user');
    } catch { localStorage.removeItem('rentsphere-user'); }
    return null;
  });

  const [verification, setVerification] = useState({ status: 'loading', account: null, token: null, error: '' });
  const [sessionRevision, setSessionRevision] = useState(0);
  const tokenRef = useRef(user?.token); tokenRef.current = user?.token;
  const requestId = useRef(0);
  const refreshAccount = useCallback(async () => {
    const token = tokenRef.current;
    const id = ++requestId.current;
    if (!token) { setVerification({ status: 'anonymous', account: null, token: null, error: '' }); return; }
    setVerification(previous => previous.token === token && previous.account
      ? previous.status === 'ready' ? previous : { ...previous, status: 'loading', error: '' }
      : { status: 'loading', account: null, token, error: '' });
    try {
      const account = await fetchCurrentAccount(token);
      if (id !== requestId.current || tokenRef.current !== token) return;
      setUser(previous => {
        if (previous?.token !== token) return previous;
        const current = { ...account, token };
        localStorage.setItem('rentsphere-user', JSON.stringify(current));
        return JSON.stringify(current) === JSON.stringify(previous) ? previous : current;
      });
      setVerification({ status: 'ready', account, token, error: '' });
      return account;
    } catch (error) {
      if (id !== requestId.current || tokenRef.current !== token) return;
      if (error.status === 401) {
        tokenRef.current = null; setUser(null); localStorage.removeItem('rentsphere-user');
        setVerification({ status: 'anonymous', account: null, token: null, error: '' });
      } else setVerification(previous => accountRefreshFailure(previous, token, error.message || 'Unable to verify your account. Please retry.'));
    }
  }, []);
  useEffect(() => {
    refreshAccount();
    window.addEventListener('focus', refreshAccount);
    return () => { ++requestId.current; window.removeEventListener('focus', refreshAccount); };
  }, [user?.token, sessionRevision, refreshAccount]);

  const login = (userData) => {
    ++requestId.current; tokenRef.current = userData.token;
    setVerification({ status: 'loading', account: null, token: userData.token, error: '' });
    setSessionRevision(previous => previous + 1);
    setUser(userData);
    localStorage.setItem('rentsphere-user', JSON.stringify(userData));
  };

  const logout = () => {
    ++requestId.current; tokenRef.current = null;
    setVerification({ status: 'anonymous', account: null, token: null, error: '' });
    setUser(null);
    localStorage.removeItem('rentsphere-user');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, refreshAccount,
      account: verification.token === user?.token ? verification.account : null,
      accountStatus: !user ? 'anonymous' : verification.token === user.token ? verification.status : 'loading',
      accountError: verification.error }}>
      {children}
    </AuthContext.Provider>
  );
};

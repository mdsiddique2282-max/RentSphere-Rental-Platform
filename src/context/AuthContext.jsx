import { createContext, useState, useEffect } from 'react';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('rentsphere-user');
    if (storedUser) {
      try {
        const parsed = JSON.parse(storedUser);
        // Discard sessions without a real token (including fake sessions created by older versions).
        if (parsed && parsed.token && parsed.token !== 'dummy-token' && parsed._id !== 'dummy') {
          setUser(parsed);
        } else {
          localStorage.removeItem('rentsphere-user');
        }
      } catch (e) {
        localStorage.removeItem('rentsphere-user');
      }
    }
  }, []);

  const login = (userData) => {
    setUser(userData);
    localStorage.setItem('rentsphere-user', JSON.stringify(userData));
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('rentsphere-user');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

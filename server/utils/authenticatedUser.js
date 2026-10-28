import User from '../models/User.js';
import { verifyToken, sessionIsCurrent } from './tokens.js';

export async function authenticatedUser(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const decoded = token && verifyToken(token);
    if (!decoded || !/^[a-f\d]{24}$/i.test(String(decoded.id))) return res.status(401).json({ message: 'Please log in.' });
    const user = await User.findById(decoded.id).select('-password').maxTimeMS(5000);
    if (!user || !sessionIsCurrent(decoded, user)) return res.status(401).json({ message: 'Please log in.' });
    req.user = user;
    next();
  } catch { res.status(401).json({ message: 'Invalid or expired session.' }); }
}

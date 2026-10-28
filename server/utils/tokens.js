import jwt from 'jsonwebtoken';

export function requireJwtSecret(secret = process.env.JWT_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 ||
      secret !== secret.trim() || new Set(secret).size < 12 ||
      /secret|change.?me|replace.?me|your[-_ ]|example|placeholder/i.test(secret)) {
    throw new Error('JWT_SECRET must be a strong, randomly generated environment value of at least 32 bytes.');
  }
  return secret;
}

export const generateToken = (id, authVersion = 0) => jwt.sign({ id, authVersion }, requireJwtSecret(), {
  algorithm: 'HS256', expiresIn: '30d'
});

export const sessionIsCurrent = (decoded, user) => (decoded?.authVersion || 0) === (user?.authVersion || 0);

export const verifyToken = token => jwt.verify(token, requireJwtSecret(), {
  algorithms: ['HS256']
});

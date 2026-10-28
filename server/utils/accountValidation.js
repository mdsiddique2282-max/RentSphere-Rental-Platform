export const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : value;
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validNewPassword = value => typeof value === 'string' && value.trim().length > 0 && value.length >= 6 && Buffer.byteLength(value, 'utf8') <= 72;
export const emailFilter = email => ({ email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });

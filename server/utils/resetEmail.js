import nodemailer from 'nodemailer';
import { validEmail } from './accountValidation.js';

export function resetEmailConfig(env = process.env) {
  const port = Number(env.SMTP_PORT);
  if (!env.SMTP_HOST || ![465, 587].includes(port) || !env.SMTP_USER || !env.SMTP_PASS || !validEmail(env.EMAIL_FROM) ||
      [env.SMTP_HOST, env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM].some(value => /[\r\n]/.test(value))) throw new Error('Password reset email is not configured.');
  const origin = new URL(env.APP_BASE_URL);
  const localHost = origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost') ||
    origin.hostname === '[::1]' || /^127\./.test(origin.hostname) || origin.hostname === '0.0.0.0';
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== '/' || (env.NODE_ENV === 'production' && (origin.protocol !== 'https:' || localHost)) ||
      (origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid reset application URL.');
  return { from: env.EMAIL_FROM, origin: origin.origin, options: { host: env.SMTP_HOST, port, secure: port === 465,
    requireTLS: true, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, logger: false, debug: false,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true } };
}
export function smtpResetMailer(config) { return nodemailer.createTransport(config.options); }

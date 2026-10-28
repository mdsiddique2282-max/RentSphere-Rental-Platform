import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import User from '../models/User.js';
import PasswordReset from '../models/PasswordReset.js';
import ResetThrottle from '../models/ResetThrottle.js';
import { normalizeEmail, validEmail, validNewPassword, emailFilter } from '../utils/accountValidation.js';
import { resetEmailConfig, smtpResetMailer } from '../utils/resetEmail.js';

const hash = value => createHash('sha256').update(value).digest('hex');
export const resetResponse = 'If an account exists for that email, a password reset email will be sent. Please check your inbox and spam folder.';

export function createPasswordResetRouter({ env = process.env, mailer = smtpResetMailer, now = () => Date.now() } = {}) {
  const router = express.Router();
  async function allowed(namespace, identity, limit, minutes) {
    const timestamp = now(), duration = minutes * 60000, bucket = Math.floor(timestamp / duration);
    const key = hash(namespace + ':' + identity + ':' + bucket);
    let counter;
    try {
      counter = await ResetThrottle.findOneAndUpdate({ _id: key }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * duration) } }, { upsert: true, returnDocument: 'after' });
    } catch (error) {
      if (error.code !== 11000) throw error;
      counter = await ResetThrottle.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, { returnDocument: 'after' });
    }
    return counter.count <= limit;
  }
  router.post('/forgot-password', async (req, res) => {
    let config;
    try { config = resetEmailConfig(env); }
    catch { return res.status(503).json({ message: 'Password reset email is not configured. The site administrator must configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM and APP_BASE_URL, then restart the backend.' }); }
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    try {
      if (!await allowed('reset-ip', req.ip, 20, 15) || !await allowed('reset-email', email, 5, 60)) return res.status(429).json({ message: 'Too many reset requests. Please try again later.' });
      const candidates = await User.find(emailFilter(email)).select('_id email');
      const token = randomBytes(32).toString('hex');
      if (candidates.length === 1) {
        const user = candidates[0], tokenHash = hash(token);
        await PasswordReset.findOneAndUpdate({ _id: user._id }, { $set: { tokenHash, expiresAt: new Date(now() + 15 * 60000) } }, { upsert: true });
        // Finish delivery before responding so request-scoped/serverless hosts
        // cannot suspend the email task after the HTTP response ends.
        try {
          const transport = mailer(config);
          const link = `${config.origin}/reset-password#${token}`;
          const result = await transport.sendMail({ from: config.from, to: user.email, subject: 'Reset your RentSphere password',
            text: `A password reset was requested for your RentSphere account.\n\nOpen this link to choose a new password:\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request this, ignore this email. Your password has not changed.` });
          if (result?.rejected?.length) throw new Error('Delivery rejected.');
        } catch {
          await PasswordReset.deleteOne({ _id: user._id, tokenHash });
          console.error('Password reset email delivery failed. Check private SMTP configuration.');
        }
      }
      // Do not reveal account existence or account-specific delivery failures.
      res.json({ message: resetResponse });
    } catch { res.status(503).json({ message: 'Unable to request a password reset. Please try again later.' }); }
  });
  router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f\d]{64}$/i.test(token)) return res.status(400).json({ message: 'Invalid or expired reset link.' });
    if (!validNewPassword(password)) return res.status(400).json({ message: 'Password must have at least 6 characters and at most 72 UTF-8 bytes.' });
    try {
      if (!await allowed('reset-redeem-ip', req.ip, 20, 15)) return res.status(429).json({ message: 'Too many attempts. Please try again later.' });
      // Hash before the transaction, then atomically consume the token and write
      // the password without running a second bcrypt save hook.
      const passwordHash = await bcrypt.hash(password, 10);
      await mongoose.connection.transaction(async session => {
        const reset = await PasswordReset.findOneAndDelete({ tokenHash: hash(token), expiresAt: { $gt: new Date(now()) } }, { session });
        if (!reset) throw Object.assign(new Error('Invalid or expired reset link.'), { status: 400 });
        const result = await User.updateOne({ _id: reset._id }, { $set: { password: passwordHash }, $inc: { authVersion: 1 } }, { session });
        if (!result.matchedCount) throw Object.assign(new Error('Invalid or expired reset link.'), { status: 400 });
      });
      res.json({ message: 'Password updated successfully. Please log in with your new password.' });
    } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to reset password. Please try again.' }); }
  });
  return router;
}
export default createPasswordResetRouter();

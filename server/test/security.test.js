import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { requireJwtSecret, generateToken, verifyToken } from '../utils/tokens.js';
import { bookingDates, bookingPrice } from '../utils/vehicleBookings.js';

process.env.JWT_SECRET = randomBytes(48).toString('hex');

test('JWT configuration rejects missing, weak and placeholder keys', () => {
  for (const key of ['', 'secret', 'a'.repeat(64), 'your-secret-should-be-at-least-32-characters']) {
    assert.throws(() => requireJwtSecret(key), /JWT_SECRET/);
  }
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  assert.throws(() => generateToken('507f1f77bcf86cd799439011'), /JWT_SECRET/);
  process.env.JWT_SECRET = saved;
});

test('JWTs preserve identity and expiry; reject default keys, other algorithms and expired tokens', () => {
  const token = generateToken('507f1f77bcf86cd799439011');
  const decoded = verifyToken(token);
  assert.equal(decoded.id, '507f1f77bcf86cd799439011');
  assert.equal(decoded.exp - decoded.iat, 30 * 86400);
  assert.throws(() => verifyToken(jwt.sign({ id: decoded.id }, 'secret')));
  assert.throws(() => verifyToken(jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, { algorithm: 'HS384' })));
  assert.throws(() => verifyToken(jwt.sign({ id: decoded.id }, process.env.JWT_SECRET, { expiresIn: -1 })));
});

test('backend pricing preserves date difference, minimum one day and fixed delivery fee', () => {
  const vehicle = { type: 'vehicle', price: 2499 };
  const sameDay = bookingDates('2030-01-01', '2030-01-01');
  const twoDays = bookingDates('2030-01-01', '2030-01-03');
  assert.deepEqual(bookingPrice(vehicle, sameDay, 'pickup'), { totalPrice: 2499, deliveryCharge: 0 });
  assert.deepEqual(bookingPrice(vehicle, twoDays, 'delivery'), { totalPrice: 5298, deliveryCharge: 300 });
  assert.deepEqual(bookingPrice({ type: 'property', price: 15000 }, twoDays, 'pickup'), { totalPrice: 15000, deliveryCharge: 0 });
});

test('invalid calendar dates, reversed ranges and invalid stored prices are rejected', () => {
  for (const [start, end] of [['2030-02-30', '2030-03-01'], ['bad', '2030-01-01'], ['2030-01-02', '2030-01-01']]) {
    assert.throws(() => bookingDates(start, end), { status: 400 });
  }
  assert.throws(() => bookingPrice({ type: 'vehicle', price: -1 }, { days: 1 }, 'pickup'), { status: 400 });
  assert.throws(() => bookingPrice({ type: 'vehicle', price: 100 }, { days: 1 }, 'invalid'), { status: 400 });
});

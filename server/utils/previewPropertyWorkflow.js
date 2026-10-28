// Shared by isolated preview and the staging compatibility routes.
import express from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { verifyToken, sessionIsCurrent } from './tokens.js';
import { syncPropertyInterestAvailability } from './propertyInterestAvailability.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });

export function previewPropertyWorkflow(preview) {
  const router = express.Router();
  const db = preview.client.db(preview.targetDatabase);
  const staging = preview.autoRentOnInterest === false;
  const decisionResult = (kind, listing) => ({ decision: kind, propertyStatus: listing.status,
    propertyAvailable: listing.available, propertyAvailability: listing.availability, recorded: true });
  router.use(async (req, res, next) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const decoded = token && verifyToken(token);
      const user = decoded && await User.findById(decoded.id);
      if (!user || !sessionIsCurrent(decoded, user)) return res.status(401).json({ message: 'Please log in to record a property decision.' });
      req.previewUser = user; next();
    } catch { res.status(401).json({ message: 'Invalid or expired login.' }); }
  });
  router.get('/property-visits/:listingId', async (req, res) => {
    if (!validId(req.params.listingId)) return res.status(400).json({ message: 'Invalid listing.' });
    const filter = { listing: new mongoose.mongo.ObjectId(req.params.listingId), user: req.previewUser._id, requestType: 'property_visit' };
    const options = { sort: { createdAt: -1, _id: -1 } };
    // Another pending/rejected request must not hide this customer's accepted visit.
    const accepted = staging && await db.collection('bookings').findOne({ ...filter, status: 'confirmed', propertyDecision: { $exists: false } }, options);
    const visit = accepted || await db.collection('bookings').findOne(filter, options);
    res.json(visit ? { requestId: String(visit._id), status: visit.status, decision: visit.propertyDecision?.kind || null,
      actionable: (staging ? visit.status === 'confirmed' : ['pending', 'confirmed'].includes(visit.status)) && !visit.propertyDecision } : null);
  });
  router.post('/property-visits/:requestId/decision', async (req, res) => {
    if (!validId(req.params.requestId) || !['interested', 'not-interested'].includes(req.body?.decision) || req.body?.confirmedInApp !== true) {
      return res.status(400).json({ message: 'Choose a decision and explicitly confirm it in RentSphere.' });
    }
    const session = preview.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const visit = await db.collection('bookings').findOne({ _id: new mongoose.mongo.ObjectId(req.params.requestId),
          user: req.previewUser._id, requestType: 'property_visit' }, { session });
        if (!visit) throw failure(404, 'Your visit request was not found.');
        const listing = await db.collection('listings').findOne({ _id: visit.listing, type: 'property' }, { session });
        if (!listing) throw failure(404, 'Property not found.');
        if (staging && visit.status !== 'confirmed') throw failure(409, 'Only an approved visit can record a decision.');
        if (visit.propertyDecision) {
          if (visit.propertyDecision.kind !== req.body.decision) throw failure(409, 'This visit already has a recorded decision.');
          return decisionResult(visit.propertyDecision.kind, staging ? await syncPropertyInterestAvailability(db, listing, session) : listing);
        }
        if (!['pending', 'confirmed'].includes(visit.status)) throw failure(409, 'This visit request is no longer active.');
        if (preview.autoRentOnInterest !== false && req.body.decision === 'interested') {
          const changed = await db.collection('listings').updateOne({ _id: listing._id, status: 'available' },
            { $set: { status: 'rented' } }, { session });
          if (!changed.matchedCount) throw failure(409, 'This property is already unavailable.');
        }
        const saved = await db.collection('bookings').updateOne({ _id: visit._id, status: visit.status, propertyDecision: { $exists: false } },
          { $set: { propertyDecision: { kind: req.body.decision, recordedAt: new Date(), confirmedBy: req.previewUser._id } } }, { session });
        if (!saved.matchedCount) throw failure(409, 'This visit changed. Please reload.');
        if (staging) return decisionResult(req.body.decision, await syncPropertyInterestAvailability(db, listing, session, req.body.decision === 'interested'));
        return { decision: req.body.decision, propertyStatus: preview.autoRentOnInterest !== false && req.body.decision === 'interested' ? 'rented' : listing.status,
          recorded: true };
      });
      await preview.save(); res.json(result);
    } catch (error) { res.status(error.status || 503).json({ message: error.status ? error.message : 'The decision could not be saved. Please retry.' }); }
    finally { await session.endSession(); }
  });
  return router;
}

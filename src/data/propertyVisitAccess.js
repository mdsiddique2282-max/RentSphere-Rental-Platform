// A record is scoped to the authenticated request that fetched it. Never use
// browser storage or a newly submitted (pending) request as visit approval.
export function canRecordPropertyInterest(record, token, listingId) {
  return Boolean(token && listingId && record?.token === token && record.listingId === String(listingId) &&
    record.requestId && record.status === 'confirmed' && record.actionable === true && !record.decision);
}

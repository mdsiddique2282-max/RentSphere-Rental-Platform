// Exact synthetic listing IDs recorded in tmp/phase2-live-fixture.json.
// This read-time exclusion preserves records, bookings, admin counts and history.
// Never use a title-prefix rule: similarly named genuine listings stay public.
export const stagingSmokeListingIds = Object.freeze([
  '6ad7a1e66af9429374cdb605', // property
  '6ad7a1e66af9429374cdb606', // vehicle
]);

export function publicCatalogFilter(databaseName) {
  return databaseName === 'rentsphere_staging'
    ? { _id: { $nin: [...stagingSmokeListingIds] } }
    : {};
}

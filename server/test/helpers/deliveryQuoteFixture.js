// Synthetic square for isolated tests only. This is NOT a Mumbai service boundary.
export const testPickup = { lat: 19.07, lon: 72.87 };
export const testDestination = { lat: 19.08, lon: 72.88 };
export const testDeliveryCharge = 445;
export function configureDeliveryQuotes(app, overrides = {}) {
  app.locals.deliveryQuoteServices = { area: async () => ({ version: 'synthetic-test-area-only', polygons: [[[[72,18],[74,18],[74,20],[72,20],[72,18]]]] }),
    env: { GEOAPIFY_API_KEY: 'mock-only' }, send: async () => ({ ok: true, status: 200, json: async () => ({ features: [{ properties: { distance: 12400, mode: 'drive', units: 'metric' } }] }) }), ...overrides };
}
export async function fixtureDeliveryBody(body, calculate) {
  if (body?.fulfilment !== 'delivery' || body.deliveryQuoteId) return body;
  const coordinates = body.deliveryCoordinates === undefined ? testDestination : body.deliveryCoordinates;
  const quote = await calculate({ ...body, deliveryCoordinates: coordinates });
  return quote.status === 200 ? { ...body, deliveryCoordinates: coordinates, deliveryQuoteId: quote.data.quoteId } : body;
}

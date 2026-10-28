import { isCoordinates } from '../data/coordinates';
import { formatPrice } from '../data/listings';
import './DeliveryPricing.css';

export default function DeliveryPricing({ state, coordinates, item, form, loggedIn }) {
  const { quote, loading, error, code, fallbackAllowed, calculate } = state;
  const ready = loggedIn && isCoordinates(coordinates) && isCoordinates(item.locationCoordinates) && form.start && form.end && form.address.trim();
  const retry = ['ROUTING_TEMPORARY', 'CLIENT_NETWORK_FAILURE', 'QUOTE_BUSY'].includes(code);
  return <section className="delivery-pricing" aria-label="Delivery pricing">
    <h3>Delivery pricing</h3>
    {!isCoordinates(item.locationCoordinates) && <p role="status">This vehicle has no confirmed map location. Its owner/admin must select a pickup location before Home Delivery can be quoted. Self Pickup remains available.</p>}
    {!isCoordinates(coordinates) && <p>Select a delivery location using autocomplete or the map to calculate the road distance.</p>}
    {loading && <p role="status" aria-live="polite">Calculating the driving route…</p>}
    {error && <p className="delivery-pricing-error" role="alert">{error}</p>}
    {quote?.kind === 'calculated' && <dl><dt>Road distance</dt><dd>{(quote.distanceMeters / 1000).toFixed(2)} km</dd>
      {quote.billableKm !== quote.distanceMeters / 1000 && <><dt>Billable distance (rounded up)</dt><dd>{quote.billableKm} km</dd></>}
      <dt>Base charge</dt><dd>₹120</dd><dt>Distance charge</dt><dd>{quote.billableKm} km × ₹25 = ₹{formatPrice(quote.billableKm * 25)}</dd>
      <dt>Total delivery charge</dt><dd>₹{formatPrice(quote.deliveryCharge)}</dd><dt>Updated booking total</dt><dd>₹{formatPrice(quote.totalPrice)}</dd></dl>}
    {quote?.kind === 'estimated' && <><strong>Estimated Delivery Charge: ₹300</strong><p>Distance could not be calculated. ₹300 is a temporary estimated delivery charge, subject to owner confirmation.</p><p>Updated booking total: <strong>₹{formatPrice(quote.totalPrice)}</strong></p></>}
    {!quote && !loading && <p>Delivery is ₹120 + ₹25 per billable road kilometre, rounded up. Review a quote before submitting.</p>}
    <div className="delivery-pricing-actions"><button type="button" className="save-button" disabled={!ready || loading} onClick={() => calculate(false)}>{loading ? 'Calculating…' : retry ? 'Retry Calculation' : quote ? 'Recalculate Delivery' : 'Calculate Delivery'}</button>
      {fallbackAllowed && !quote && <button type="button" className="save-button" disabled={!ready || loading} onClick={() => calculate(true)}>Confirm ₹300 Estimated Delivery</button>}</div>
    {fallbackAllowed && !quote && <p>Distance could not be calculated. ₹300 is a temporary estimated delivery charge, subject to owner confirmation. Select it explicitly to continue.</p>}
  </section>;
}

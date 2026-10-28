import { useCallback, useEffect, useRef, useState } from 'react';

export default function useDeliveryQuote({ user, item, form, coordinates, active }) {
  const scope = JSON.stringify([user?.token, item._id || item.id, item.price, item.location, item.locationCoordinates, form.start, form.end, form.address, coordinates, active]);
  const [state, setState] = useState(null), current = useRef(scope), controller = useRef(), locked = useRef(false);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    locked.current = false; controller.current?.abort(); setState(null);
    return () => { if (current.current === scope) current.current = ''; controller.current?.abort(); };
  }, [scope]);
  const quote = state?.scope === scope ? state.quote : null;
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => { if (current.current === scope) setState({ scope, error: 'Your delivery quote expired. Recalculate before booking.', code: 'STALE_DELIVERY_QUOTE' }); }, Math.max(0, Date.parse(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, scope]);
  const calculate = useCallback(async (fallback = false) => {
    if (locked.current || !active || !user?.token) return;
    locked.current = true; const abort = new AbortController(); controller.current = abort;
    setState({ scope, loading: true });
    try {
      const response = await fetch('/api/bookings/delivery-quote', { method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ listingId: item._id || item.id, startDate: form.start, endDate: form.end, deliveryAddress: form.address, deliveryCoordinates: coordinates, fallback }) });
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (current.current !== scope) return;
      if (!response.ok || !data) { setState({ scope, error: data?.message || 'Unable to calculate delivery. Please retry.', code: data?.code, fallbackAllowed: data?.fallbackAllowed === true }); return; }
      if (!data.quoteId || !['calculated', 'estimated'].includes(data.kind) || !Number.isSafeInteger(data.deliveryCharge) || data.deliveryCharge < 0 || !Number.isFinite(data.totalPrice) || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('Invalid quote');
      setState({ scope, quote: data });
    } catch (error) { if (current.current === scope && error.name !== 'AbortError') setState({ scope, error: 'Unable to calculate delivery. Please retry.', code: 'CLIENT_NETWORK_FAILURE' }); }
    finally { if (current.current === scope) locked.current = false; }
  }, [scope]);
  const invalidate = () => setState(null);
  return { ...(state?.scope === scope ? state : {}), quote, calculate, invalidate };
}

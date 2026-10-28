// Shared optional coordinate shape: { lat: number, lon: number }, in degrees.
// null is accepted only as an explicit instruction to clear a listing pin.
export function isCoordinates(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
    typeof value.lat === 'number' && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 &&
    typeof value.lon === 'number' && Number.isFinite(value.lon) && Math.abs(value.lon) <= 180);
}
export function coordinateValue(value, allowClear = false) {
  if (value === undefined || (allowClear && value === null)) return value;
  if (!isCoordinates(value)) throw Object.assign(new Error('Coordinates must contain numeric lat (-90 to 90) and lon (-180 to 180).'), { status: 400 });
  return { lat: value.lat, lon: value.lon };
}

export async function reverseAddress(coordinates, { key, signal, send = fetch }) {
  coordinateValue(coordinates);
  if (!key) throw new Error('Map service is not configured. You can still enter an address manually.');
  try {
    const response = await send(`https://api.geoapify.com/v1/geocode/reverse?lat=${coordinates.lat}&lon=${coordinates.lon}&apiKey=${encodeURIComponent(key)}`, { signal });
    if (!response.ok) throw new Error('Geocoding unavailable');
    const data = await response.json();
    const address = data.features?.[0]?.properties?.formatted;
    if (typeof address !== 'string' || !address.trim()) throw new Error('Address unavailable');
    return address.trim();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Unable to resolve this pin. Retry, or enter its address below; your selected pin is unchanged.');
  }
}

export async function searchAddresses(text, { key, signal, send = fetch }) {
  if (!key) throw new Error('Map search is not configured.');
  try {
    const response = await send('https://api.geoapify.com/v1/geocode/autocomplete?text=' + encodeURIComponent(text) + '&filter=countrycode:in&limit=10&apiKey=' + encodeURIComponent(key), { signal });
    if (!response.ok) throw new Error('Search unavailable');
    const data = await response.json();
    return (data.features || []).map(row => row.properties).filter(row => typeof row?.formatted === 'string' && isCoordinates({ lat: row.lat, lon: row.lon }));
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Address search is unavailable. Retry or choose a pin on the map.');
  }
}

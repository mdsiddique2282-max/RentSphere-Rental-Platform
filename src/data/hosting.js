import { coordinateValue } from './coordinates.js';
// Shared by the hosting UI and Express validation; never applied as a migration.
export const propertyCategories = ['Apartment', 'Villa', 'House', 'Room', 'Studio'];
export const vehicleCategories = { Car: ['Car', 'SUV', 'Sedan', 'Hatchback', 'MPV', 'Luxury', 'Electric'], Bike: ['Bike', 'Scooter', 'Street bike', 'Sport bike', 'Roadster', 'Cruiser', 'Adventure', 'Sports', 'Electric'] };
export const furnishings = ['Furnished', 'Semi-furnished', 'Unfurnished', 'Fully furnished'];
export const fuels = ['Petrol', 'Diesel', 'Electric', 'Hybrid', 'Petrol mild hybrid', 'CNG'];
export const transmissions = ['Manual', 'Automatic', 'CVT automatic', 'IVT automatic'];
export const amenityOptions = ['Parking', 'Security', 'WiFi', 'Lift', 'Power backup', 'Water supply', 'Balcony', 'Gym', 'Swimming pool'];
export const featureOptions = ['Air conditioning', 'GPS navigation', 'Bluetooth', 'USB charging', 'Helmet', 'ABS', 'Sanitized'];
const propertyAmenities = {
  Apartment: ['Parking', 'Security', 'WiFi', 'Lift', 'Power backup', 'Water supply', 'Balcony', 'Gym', 'CCTV'],
  Villa: ['Parking', 'Security', 'WiFi', 'Swimming pool', 'Garden', 'Balcony', 'Power backup', 'Water supply', 'Air conditioning'],
  House: ['Parking', 'WiFi', 'Water supply', 'Power backup', 'Balcony', 'Security', 'Garden', 'Air conditioning', 'Storage'],
  Room: ['WiFi', 'Water supply', 'Attached bathroom', 'Furnished', 'Air conditioning', 'Power backup', 'Security', 'Laundry', 'Parking'],
  Studio: ['WiFi', 'Air conditioning', 'Attached bathroom', 'Kitchenette', 'Furnished', 'Water supply', 'Power backup', 'Security', 'Parking'],
};
const vehicleFeatures = {
  Car: ['Air conditioning', 'GPS navigation', 'Bluetooth', 'USB charging', 'ABS', 'Airbags', 'Power steering', 'Music system', 'Sanitized'],
  Bike: ['Helmet', 'ABS', 'Bluetooth', 'USB charging', 'GPS navigation', 'Mobile holder', 'Disc brakes', 'Electric start', 'Sanitized'],
};
export function hostingChoiceOptions(form) {
  if (form.type === 'property') return propertyAmenities[form.category] || propertyAmenities.Apartment;
  const options = vehicleFeatures[form.kind] || vehicleFeatures.Car;
  return form.category === 'Electric' ? [...options.filter(x => x !== 'Electric start'), 'Charging cable'] : options;
}
export const hostingChoiceKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
export function addHostingChoice(selected, value) {
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 100) throw new Error('Enter an amenity or feature between 1 and 100 characters.');
  if (selected.some(x => hostingChoiceKey(x) === hostingChoiceKey(clean))) throw new Error('This amenity or feature is already selected.');
  if (selected.length >= 40) throw new Error('Choose at most 40 amenities or features.');
  return [...selected, clean];
}
export const mobilePattern = /^(?:\+91[\s-]?)?[6-9]\d{9}$/;
export function hostingValues(item = {}) {
  const type = item.type || 'property';
  const kind = item.kind || (vehicleCategories.Bike.includes(item.category) && item.category !== 'Electric' ? 'Bike' : 'Car');
  return { type, title: item.title || item.name || '', category: item.category || (type === 'property' ? 'Apartment' : kind), kind,
    location: item.location || '', ...(item.locationCoordinates ? { locationCoordinates: { ...item.locationCoordinates } } : {}), price: item.price ?? '', description: item.description || '', phone: (item.phone || '').replace(/[\s-]/g, ''),
    area: item.area ?? '', bhk: item.bhk ?? '', furnishing: item.furnishing || '', floor: item.floor || '',
    fuel: item.fuel || '', transmission: item.transmission || '', seats: item.seats ?? '',
    amenities: [...(item.amenities || [])], features: [...(item.features || [])] };
}
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function validateHosting(values, { partial = false, type = values.type, kind = values.kind } = {}) {
  if (!['property', 'vehicle'].includes(type)) fail('Choose Property or Vehicle.');
  const out = {};
  if (values.locationCoordinates !== undefined) {
    out.locationCoordinates = coordinateValue(values.locationCoordinates, true);
  }
  const text = (key, label, choices) => {
    if (partial && values[key] === undefined) return;
    const value = values[key];
    if (typeof value !== 'string' || !value.trim() || value.length > (key === 'description' ? 10000 : 500)) fail(`${label} is required and must be valid text.`);
    if (choices && !choices.includes(value)) fail(`Choose a valid ${label.toLowerCase()}.`);
    out[key] = value.trim();
  };
  const number = (key, label, min, integer = false, max = 1e9) => {
    if (partial && values[key] === undefined) return;
    const value = values[key];
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max || (integer && !Number.isInteger(Number(value)))) fail(`${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
    out[key] = Number(value);
  };
  text('title', type === 'property' ? 'Property title' : 'Vehicle name'); text('location', 'Complete location/address');
  number('price', 'Rental price', 0); text('description', 'Detailed description'); text('phone', 'Owner contact number');
  if (out.phone) { out.phone = out.phone.replace(/[\s-]/g, ''); if (!mobilePattern.test(out.phone)) fail('Enter a valid Indian mobile number (10 digits, starting with 6–9).'); }
  if (type === 'property') {
    text('category', 'Property category', propertyCategories); number('area', 'Home size', 1);
    number('bhk', 'BHK/layout', 0, true, 50); text('furnishing', 'Furnishing', furnishings); text('floor', 'Floor');
  } else {
    if (!partial || values.kind !== undefined) text('kind', 'Vehicle type', ['Car', 'Bike']);
    if ((!partial || values.category !== undefined) && !vehicleCategories[kind]) fail('Choose Car or Bike.');
    text('category', 'Vehicle category', vehicleCategories[kind]); text('fuel', 'Fuel type', fuels);
    text('transmission', 'Transmission', transmissions); number('seats', 'Seating capacity', 1, true, 60);
  }
  const list = type === 'property' ? 'amenities' : 'features';
  if (!partial || values[list] !== undefined) {
    if (!Array.isArray(values[list]) || values[list].length > 40 || values[list].some(x => typeof x !== 'string' || !x.trim() || x.length > 100)) fail(`Choose valid ${list}.`);
    const clean = values[list].map(x => x.trim().replace(/\s+/g, ' '));
    out[list] = clean.filter((value, index) => clean.findIndex(x => hostingChoiceKey(x) === hostingChoiceKey(value)) === index);
  }
  return out;
}

// Preserve unchanged legacy locations; new or changed locations need a validated pin.
export function hostingLocationChanged(values, existing) {
  return !existing || values.location?.trim() !== existing.location?.trim() ||
    (values.locationCoordinates?.lat ?? null) !== (existing.locationCoordinates?.lat ?? null) ||
    (values.locationCoordinates?.lon ?? null) !== (existing.locationCoordinates?.lon ?? null);
}
export async function validateHostingLocation(values, existing, token, send = fetch) {
  if (!hostingLocationChanged(values, existing)) return;
  if (!values.locationCoordinates) throw new Error('Choose a valid location on the map before publishing.');
  coordinateValue(values.locationCoordinates);
  const response = await send('/api/listings/validate-location', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ locationCoordinates: values.locationCoordinates }) });
  let data;
  try { data = await response.json(); } catch { throw new Error('Unable to validate the service area. Please retry.'); }
  if (!response.ok || data.valid !== true) throw new Error(data.message || 'Unable to validate the service area. Please retry.');
}

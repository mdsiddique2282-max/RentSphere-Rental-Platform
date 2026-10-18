// City + area location filter shared by the Properties AND Vehicles pages.
// Cities: Mumbai, Pune, Delhi.
// Matching uses ONLY the listing's stored `location` text. No GPS, no guessing, no mock detection.
// A listing stored as just "Mumbai, Maharashtra" belongs to the city Mumbai but to NO specific area.

const area = (value, ...extraTerms) => ({ value, terms: [value.toLowerCase(), ...extraTerms] });

export const CITIES = [
  {
    name: 'Mumbai',
    terms: ['mumbai', 'bombay'],
    areas: [
      area('Andheri'), area('Bandra'), area('Bhandup'), area('Borivali'), area('Byculla'), area('Chembur'),
      area('Colaba'), area('Dadar'), area('Ghatkopar'), area('Goregaon'), area('Juhu'),
      area('Kandivali', 'kandivli'), area('Kurla'), area('Lower Parel'), area('Malad'), area('Matunga'),
      area('Mulund'), area('Navi Mumbai'), area('Powai'), area('Santacruz', 'santa cruz'), area('Sion'),
      area('Thane'), area('Vashi'), area('Versova'), area('Vikhroli'), area('Vile Parle', 'vileparle'), area('Worli'),
    ],
  },
  {
    name: 'Pune',
    terms: ['pune'],
    areas: [
      area('Aundh'), area('Baner'), area('Chinchwad'), area('Hadapsar'), area('Hinjewadi', 'hinjawadi'),
      area('Kharadi'), area('Koregaon Park'), area('Kothrud'), area('Pimpri'),
      area('Shivajinagar', 'shivaji nagar'), area('Viman Nagar', 'vimannagar'), area('Wakad'),
    ],
  },
  {
    name: 'Delhi',
    terms: ['delhi'],
    areas: [
      area('Connaught Place'), area('Dwarka'), area('Greater Kailash'), area('Janakpuri', 'janak puri'),
      area('Karol Bagh'), area('Lajpat Nagar'), area('Pitampura'), area('Rajouri Garden'),
      area('Rohini'), area('Saket'), area('Vasant Kunj'),
    ],
  },
];

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export const getCity = name => CITIES.find(c => sameText(c.name, name)) || null;
export const getArea = (cityName, areaName) => getCity(cityName)?.areas.find(a => sameText(a.value, areaName)) || null;

// lower-case, strip punctuation, pad with spaces so whole words/phrases can be matched safely
const normalise = text => ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const hasTerm = (normalised, term) => normalised.includes(` ${term} `);
const mentionsCity = (n, city) => city.terms.some(t => hasTerm(n, t));
const mentionsArea = (n, a) => a.terms.some(t => hasTerm(n, t));
const mentionsOtherCity = (n, city) => CITIES.some(c => c !== city && mentionsCity(n, c));

// cityName: '' (no location filter) | 'Mumbai' | 'Pune' | 'Delhi'
// areaName: '' (whole city) | one of that city's areas
export const matchesLocation = (location, cityName, areaName = '') => {
  if (!cityName) return true;
  const city = getCity(cityName);
  if (!city) return true;
  const n = normalise(location);
  const areaOnlyOk = !mentionsOtherCity(n, city); // "Andheri" alone is fine; "Andheri, Pune" is not Mumbai
  const selected = areaName ? getArea(city.name, areaName) : null;
  if (selected) return mentionsArea(n, selected) && areaOnlyOk;
  return mentionsCity(n, city) || (areaOnlyOk && city.areas.some(a => mentionsArea(n, a)));
};

// Reads ?city=Pune&area=Baner from a URL search string (used by the footer city links)
export const readLocationParams = search => {
  const sp = new URLSearchParams(search || '');
  const city = getCity(sp.get('city'));
  const selectedArea = city ? getArea(city.name, sp.get('area')) : null;
  return { city: city ? city.name : '', area: selectedArea ? selectedArea.value : '' };
};

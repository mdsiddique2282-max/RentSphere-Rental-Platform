export const hostingFixture = (type = 'property', { legacy = false } = {}) => ({
  ...(!legacy ? { locationCoordinates: { lat: 19.07, lon: 72.87 } } : {}),
  type, title: 'Disposable complete listing', location: 'Full test address, Mumbai, Maharashtra', price: 1200,
  description: 'Detailed disposable test listing description.', phone: '9876543210', image: 'https://example.test/fixture.jpg',
  ...(type === 'property' ? { category: 'Apartment', area: 650, bhk: 2, furnishing: 'Semi-furnished', floor: '3rd floor', amenities: ['Parking'] }
    : { kind: 'Car', category: 'Sedan', fuel: 'Petrol', transmission: 'Manual', seats: 5, features: ['Bluetooth'] }),
});

import { Fragment } from 'react';
import { formatPrice } from '../data/listings';
import { vehicleBookingDetails } from '../data/vehicleBookingDetails';

export default function VehicleBookingFacts({ row, admin = false }) {
  const details = vehicleBookingDetails(row);
  const money = value => Number.isFinite(value) ? `₹${formatPrice(value)}` : 'Not recorded';
  const facts = [
    ['Pickup address', details.pickupAddress || 'Not recorded', true],
    ...(details.delivery ? [['Delivery address', details.deliveryAddress || 'Not recorded', true],
      ['Road distance', details.estimated ? 'Not calculated — estimated delivery charge, subject to owner confirmation' : details.distance !== undefined ? `${(details.distance / 1000).toFixed(2)} km` : 'Not recorded', true]] : []),
    ...(admin ? [['Daily rent', money(details.dailyRate)]] : []),
    ['Rental amount', money(details.rental)], ['Delivery charge', money(details.charge)], ['Total booking amount', money(details.total)],
  ];
  const url = details.delivery ? details.routeUrl : details.locationUrl;
  if (url) facts.push(['Location', <a className="text-link" href={url} target="_blank" rel="noopener noreferrer">{details.delivery ? 'View Route' : 'View Pickup Location'}</a>, true]);
  return facts.map(([label, value, wide]) => admin
    ? <div key={label} className={wide ? 'admin-request-wide' : undefined}><dt>{label}</dt><dd className={label === 'Total booking amount' ? 'admin-request-amount' : undefined}>{value}</dd></div>
    : <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>);
}

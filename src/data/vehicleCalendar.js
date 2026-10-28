export function calendarWindow(month, start = '', end = '') {
  const first = month + '-01';
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { from: start && start < first ? start : first, to: end && end > last ? end : last };
}

export function shiftCalendarMonth(month, amount) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + amount, 1)).toISOString().slice(0, 7);
}

export function vehicleDateState(date, data, today) {
  if (date < today) return 'past';
  if (data.bookedRanges.some(row => row.startDate.slice(0, 10) <= date && row.endDate.slice(0, 10) >= date)) return 'booked';
  return data.available ? 'available' : 'unavailable';
}

export function vehicleRangeAvailable(start, end, data, today) {
  return Boolean(data?.available && start >= today && end >= start && data.from <= start && data.to >= end &&
    !data.bookedRanges.some(row => row.startDate.slice(0, 10) <= end && row.endDate.slice(0, 10) >= start));
}

export function selectVehicleDate(date, field, start, end, data, today) {
  if (!data || date < data.from || date > data.to || vehicleDateState(date, data, today) !== 'available') return null;
  if (field === 'start' || !start || date < start) {
    return { start: date, end: end && vehicleRangeAvailable(date, end, data, today) ? end : '', field: 'end' };
  }
  return vehicleRangeAvailable(start, date, data, today) ? { start, end: date, field: 'start' } : null;
}

export function releasableBooking(date, data, today) {
  return date >= today ? data?.bookedRanges.find(row => row._id && row.startDate.slice(0, 10) <= date && row.endDate.slice(0, 10) >= date) : undefined;
}

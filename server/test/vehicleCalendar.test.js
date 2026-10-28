import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarWindow, shiftCalendarMonth, vehicleDateState, vehicleRangeAvailable, selectVehicleDate } from '../../src/data/vehicleCalendar.js';

const today = '2095-01-05';
const data = { from: '2095-01-01', to: '2095-02-28', available: true,
  bookedRanges: [{ startDate: '2095-01-10T00:00:00Z', endDate: '2095-01-12T00:00:00Z' },
    { startDate: '2095-01-31T00:00:00Z', endDate: '2095-02-02T00:00:00Z' }] };

test('calendar dates are inclusive, past dates stay disabled, and overall availability is separate from reservations', () => {
  for (const day of ['10', '11', '12']) assert.equal(vehicleDateState('2095-01-' + day, data, today), 'booked');
  assert.equal(vehicleDateState('2095-01-04', data, today), 'past');
  assert.equal(vehicleDateState(today, data, today), 'available');
  assert.equal(vehicleDateState('2095-01-13', data, today), 'available');
  assert.equal(vehicleDateState('2095-01-13', { ...data, available: false }, today), 'unavailable');
  assert.equal(vehicleDateState('2095-01-10', data, '2095-02-01'), 'past');
  assert.equal(vehicleDateState('2095-02-03', data, '2095-02-01'), 'available');
});

test('start/end selection cannot cross confirmed dates, including month boundaries, or use unloaded dates', () => {
  assert.deepEqual(selectVehicleDate('2095-01-06', 'start', '', '', data, today), { start: '2095-01-06', end: '', field: 'end' });
  assert.deepEqual(selectVehicleDate('2095-01-09', 'end', '2095-01-06', '', data, today), { start: '2095-01-06', end: '2095-01-09', field: 'start' });
  assert.equal(selectVehicleDate('2095-01-13', 'end', '2095-01-06', '', data, today), null);
  assert.equal(selectVehicleDate('2095-02-03', 'end', '2095-01-29', '', data, today), null);
  for (const date of ['2095-01-04', '2095-01-10', '2095-01-12', '2095-03-01']) assert.equal(selectVehicleDate(date, 'start', '', '', data, today), null);
  assert.equal(selectVehicleDate(today, 'start', '', '', null, today), null);
  assert.equal(selectVehicleDate(today, 'start', '', '', { ...data, available: false }, today), null);
  assert.equal(vehicleRangeAvailable('2095-01-13', '2095-01-14', data, today), true);
  assert.equal(vehicleRangeAvailable('2095-01-12', '2095-01-14', data, today), false);
  assert.equal(vehicleRangeAvailable('2095-01-14', '2095-01-13', data, today), false);
  assert.equal(vehicleRangeAvailable('2095-01-29', '2095-03-01', data, today), false);
  assert.deepEqual(selectVehicleDate('2095-01-08', 'end', '2095-01-09', '', data, today), { start: '2095-01-08', end: '', field: 'end' });
  assert.deepEqual(selectVehicleDate('2095-01-06', 'start', '2095-01-13', '2095-01-14', data, today), { start: '2095-01-06', end: '', field: 'end' });
});

test('calendar month windows cover the whole selection so hidden intervening months cannot bypass booking blocks', () => {
  assert.deepEqual(calendarWindow('2095-02', '2095-01-29'), { from: '2095-01-29', to: '2095-02-28' });
  assert.deepEqual(calendarWindow('2096-02'), { from: '2096-02-01', to: '2096-02-29' });
  assert.deepEqual(calendarWindow('2095-01', '2095-01-04', '2095-02-03'), { from: '2095-01-01', to: '2095-02-03' });
  assert.equal(shiftCalendarMonth('2095-12', 1), '2096-01');
  assert.equal(shiftCalendarMonth('2096-01', -1), '2095-12');
});


test('only identified future confirmed ranges can expose owner calendar release; public and past days remain read-only', async () => {
  const {releasableBooking}=await import('../../src/data/vehicleCalendar.js');
  assert.equal(releasableBooking('2095-01-10',data,today),undefined,'public ranges have no booking ID');
  const managed={...data,bookedRanges:data.bookedRanges.map((row,index)=>({...row,_id:String(index)}))};
  assert.equal(releasableBooking('2095-01-11',managed,today)._id,'0');
  assert.equal(releasableBooking('2095-01-11',managed,'2095-01-12'),undefined);
  assert.equal(releasableBooking('2095-01-13',managed,today),undefined);
  const cancelled={...managed,bookedRanges:managed.bookedRanges.slice(1)};
  for(const date of ['2095-01-10','2095-01-11','2095-01-12'])assert.equal(vehicleDateState(date,cancelled,today),'available');
  assert.equal(vehicleRangeAvailable('2095-01-10','2095-01-12',cancelled,today),true);
  assert.equal(vehicleDateState('2095-01-04',cancelled,today),'past');
});

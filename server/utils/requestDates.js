// RentSphere operates in India. Calendar dates must not depend on the server's
// timezone (including when hosted in UTC).
export function todayInIndia(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function assertNotPastDate(date, now = new Date()) {
  if (date.toISOString().slice(0, 10) < todayInIndia(now)) {
    throw Object.assign(new Error('Choose today or a future date.'), { status: 400 });
  }
}

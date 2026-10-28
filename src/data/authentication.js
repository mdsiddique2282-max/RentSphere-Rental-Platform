export function authValidation(values, register) {
  if (register && !values.name.trim()) return 'Please add your name.';
  const email = values.email.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  if (!values.password || !values.password.trim()) return 'Please enter your password.';
  if (register && values.password.length < 6) return 'Password must be at least 6 characters.';
  if (register && new TextEncoder().encode(values.password).length > 72) return 'Password must use at most 72 UTF-8 bytes.';
  return '';
}

export async function submitAuthentication({ values, register, login, navigate, notify, fetcher = fetch }) {
  const fail = message => { notify(message, 'error'); return { error: message }; };
  const validation = authValidation(values, register);
  if (validation) return fail(validation);
  const unavailable = register ? 'Unable to create account. Please try again.' : 'Unable to log in. Please try again.';
  let res, data;
  try {
    res = await fetcher(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
    });
    data = await res.json();
  } catch { return fail(unavailable); }
  if (!res.ok) {
    if (res.status >= 500) return fail(unavailable);
    if (!register && res.status === 401) return fail('Invalid email or password.');
    if (register && res.status === 400 && /already exists|already registered/i.test(data?.message || '')) return fail('This email is already registered.');
    return fail(typeof data?.message === 'string' ? data.message : unavailable);
  }
  if (!data?._id || typeof data.token !== 'string' || !data.token) return fail(unavailable);
  login(data);
  const success = register ? 'Account created successfully!' : 'Logged in successfully!';
  notify(success, 'success');
  navigate(data.role === 'admin' ? '/admin' : '/dashboard');
  return { success };
}

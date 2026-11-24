// One-password login for the dashboard. The cookie holds an HMAC of a fixed
// string keyed by ADMIN_PASSWORD, so changing the password logs everyone out.

const COOKIE = 'mc_session';

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isLoggedIn(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]+)`));
  if (!m) return false;
  return timingSafeEqual(m[1], await sign(env.ADMIN_PASSWORD, 'admin-v1'));
}

export async function checkPassword(env, password) {
  if (!env.ADMIN_PASSWORD) return false;
  const a = await sign('cmp', String(password || ''));
  const b = await sign('cmp', env.ADMIN_PASSWORD);
  return timingSafeEqual(a, b);
}

export async function sessionCookie(env, secure) {
  const v = await sign(env.ADMIN_PASSWORD, 'admin-v1');
  return `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Session token: obtained from EC2 /auth/login with the password, stored in
// sessionStorage (cleared when the tab closes — a demo laptop left open does not stay
// logged in forever). The token is a signed HMAC session, verified server-side on both
// tiers, so holding it here is safe; it expires on its own.
import { EC2_URL } from './config.js'

const KEY = 'nileair_session'

export function getToken() {
  return sessionStorage.getItem(KEY) || null
}

export function setToken(t) {
  if (t) sessionStorage.setItem(KEY, t)
  else sessionStorage.removeItem(KEY)
}

export function isAuthed() {
  return !!getToken()
}

export async function login(password) {
  const r = await fetch(`${EC2_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (r.status === 401) throw new Error('Wrong password')
  if (!r.ok) throw new Error(`Login failed (${r.status})`)
  const { token } = await r.json()
  setToken(token)
  return token
}

export function logout() {
  setToken(null)
  location.hash = '#/login'
  location.reload()
}

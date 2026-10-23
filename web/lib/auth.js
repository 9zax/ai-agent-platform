'use client'

// Session helpers — token lives in localStorage; authFetch attaches it to every API call
export function getToken() {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('aap_token') || ''
}

export function getUser() {
  if (typeof window === 'undefined') return null
  try { return JSON.parse(localStorage.getItem('aap_user') || 'null') } catch { return null }
}

export function setSession(token, user) {
  localStorage.setItem('aap_token', token)
  localStorage.setItem('aap_user', JSON.stringify({ username: user }))
}

export function clearSession() {
  localStorage.removeItem('aap_token')
  localStorage.removeItem('aap_user')
}

export async function authFetch(url, options = {}) {
  const token = getToken()
  const headers = { ...(options.headers || {}) }
  if (token) headers['x-session-token'] = token
  const res = await fetch(url, { ...options, headers })
  // A stale session (e.g. the orchestrator restarted and wiped its in-memory
  // sessions) would 401 every poll on every page — clear it and bounce to the
  // login page once instead of spamming errors. The login endpoint itself is
  // excluded so a wrong password stays on the form.
  if (res.status === 401 && typeof window !== 'undefined'
      && !url.includes('/auth/login') && window.location.pathname !== '/login') {
    clearSession()
    window.location.href = '/login'
  }
  return res
}

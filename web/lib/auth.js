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

export function authFetch(url, options = {}) {
  const token = getToken()
  const headers = { ...(options.headers || {}) }
  if (token) headers['x-session-token'] = token
  return fetch(url, { ...options, headers })
}

// Shared dashboard activity log — timestamped ring buffer with levels.
// Any dashboard component can push; the ActivityLog panel renders live.
// Levels: info | ok | warn | alert | error
import { useSyncExternalStore } from 'react'

const MAX_ENTRIES = 150
let seq = 0
let entries = []
const listeners = new Set()

const COLORS = {
  info: '#7c8699',
  ok: '#22c55e',
  warn: '#eab308',
  alert: '#ef4444',
  error: '#ef4444',
}

function notify() {
  listeners.forEach((fn) => { try { fn() } catch {} })
}

export function logActivity(level, msg) {
  const safe = COLORS[level] ? level : 'info'
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), {
    id: ++seq,
    at: new Date(),
    level: safe,
    msg: String(msg),
  }]
  notify()
}

export function clearActivity() {
  entries = []
  notify()
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot() {
  return entries
}

export function useActivity() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function activityColor(level) {
  return COLORS[level] ?? COLORS.info
}

// Log the first occurrence of each key per mount (dedupes reconnect storms).
const seenOnce = new Set()
export function logOnce(key, level, msg) {
  if (seenOnce.has(key)) return
  seenOnce.add(key)
  logActivity(level, msg)
}

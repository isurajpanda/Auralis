// Phone ringtones synthesized with WebAudio — no asset files needed.
//
// startRingback() — what the CALLER hears while waiting (US ringback:
//                   440+480Hz, 2s on / 4s off).
// startRinger()   — what the CALLEE hears on incoming (double-burst
//                   700+900Hz trill, clearly distinct from ringback).
// startBusy()     — engaged/busy tone (480+620Hz, 0.5s on / 0.5s off loop).
//                   Call stopBusy() or stopAll() to silence (auto-stops
//                   after a few seconds via stopBusyAfter()).
// playEnded()     — one-shot call-ended confirmation (two descending beeps).
// playDeclined()  — one-shot declined/rejected blip (two low beeps).
// playNoAnswer()  — one-shot no-answer triple blip.
// stopRingback() / stopRinger() / stopBusy() / stopAll() — call on every
//                   state change; players are singletons so double-start
//                   is safe.

let ctx = null
let ringback = null
let ringer = null
let busy = null
let busyTimer = null

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  return ctx
}

// One-shot resume on first user gesture (autoplay policy may block the
// incoming ringer if the tab never had interaction yet).
if (typeof window !== 'undefined') {
  const unlock = () => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

// Pattern player: `bursts` = [onMs, offMs, onMs, offMs, ...] repeating,
// `gapMs` = silence after each full cycle. Returns a stop() fn.
function playPattern(freqs, bursts, gapMs, level = 0.16) {
  const ac = audio()
  if (!ac) return () => {}
  let stopped = false
  let timers = []

  const osc = freqs.map((f) => {
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.value = f
    return o
  })
  const gain = ac.createGain()
  gain.gain.value = 0
  osc.forEach((o) => o.connect(gain))
  gain.connect(ac.destination)
  osc.forEach((o) => o.start())

  const ramp = (t, v) => gain.gain.linearRampToValueAtTime(v, t)

  function cycle() {
    if (stopped) return
    let t = ac.currentTime + 0.03
    gain.gain.cancelScheduledValues(t)
    gain.gain.setValueAtTime(gain.gain.value, t)
    for (let i = 0; i < bursts.length; i += 2) {
      const on = bursts[i] / 1000
      const off = (bursts[i + 1] || 0) / 1000
      ramp(t + 0.02, level)
      ramp(t + on, 0.0001)
      t += on + off
    }
    const total = (t - ac.currentTime) * 1000 + gapMs
    timers.push(setTimeout(cycle, total))
  }
  cycle()

  return () => {
    stopped = true
    timers.forEach(clearTimeout)
    timers = []
    try {
      const t = ac.currentTime
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0.0001, t + 0.08)
      setTimeout(() => osc.forEach((o) => { try { o.stop() } catch {} }), 150)
    } catch {}
  }
}

export function startRingback() {
  if (ringback) return
  ringback = playPattern([440, 480], [2000, 4000], 0)
}

export function stopRingback() {
  if (ringback) { ringback(); ringback = null }
}

export function startRinger() {
  if (ringer) return
  ringer = playPattern([700, 900], [400, 200, 400, 2000], 0, 0.2)
}

export function stopRinger() {
  if (ringer) { ringer(); ringer = null }
}

export function startBusy() {
  if (busy) return
  busy = playPattern([480, 620], [500, 500], 0, 0.18)
}

export function stopBusy() {
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null }
  if (busy) { busy(); busy = null }
}

// Start busy tone that silences itself after `ms` (default 4s) so a
// missed dismissal can't leave it ringing forever. Returns timer id.
export function stopBusyAfter(ms = 4000) {
  if (busyTimer) clearTimeout(busyTimer)
  busyTimer = setTimeout(stopBusy, ms)
  return busyTimer
}

// One-shot beep sequence: `steps` = [[freqHz, startMs, durMs], ...].
function playBeeps(steps, level = 0.2) {
  const ac = audio()
  if (!ac) return
  const t0 = ac.currentTime + 0.03
  const oscs = []
  try {
    steps.forEach(([freq, startMs, durMs]) => {
      const o = ac.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq
      const g = ac.createGain()
      g.gain.value = 0.0001
      o.connect(g)
      g.connect(ac.destination)
      o.start(t0 + startMs / 1000)
      const t = t0 + startMs / 1000
      g.gain.setValueAtTime(0.0001, t)
      g.gain.linearRampToValueAtTime(level, t + 0.02)
      g.gain.linearRampToValueAtTime(0.0001, t + durMs / 1000)
      o.stop(t + durMs / 1000 + 0.05)
      oscs.push(o)
    })
  } catch {}
}

export function playEnded() {
  // descending confirmation: 880 -> 660
  playBeeps([[880, 0, 160], [660, 200, 260]])
}

export function playDeclined() {
  // low double blip
  playBeeps([[440, 0, 160], [440, 220, 160]], 0.18)
}

export function playNoAnswer() {
  // triple mid blip
  playBeeps([[660, 0, 140], [660, 200, 140], [660, 400, 220]], 0.18)
}

export function stopAll() {
  stopRingback()
  stopRinger()
  stopBusy()
}

// One-shot urgent triple-beep for high threat. Plays once per call (caller
// repeats it on an interval while the threat stays high).
export function playThreatBeep() {
  const ac = audio()
  if (!ac) return
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.value = 880
  const g = ac.createGain()
  g.gain.value = 0.0001
  o.connect(g)
  g.connect(ac.destination)
  o.start()
  const t0 = ac.currentTime + 0.03
  ;[0, 0.25, 0.5].forEach((off, i) => {
    const dur = i === 2 ? 0.35 : 0.15
    g.gain.setValueAtTime(0.0001, t0 + off)
    g.gain.linearRampToValueAtTime(0.22, t0 + off + 0.02)
    g.gain.linearRampToValueAtTime(0.0001, t0 + off + dur)
  })
  setTimeout(() => { try { o.stop() } catch {} }, 1200)
}

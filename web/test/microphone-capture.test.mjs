import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireEchoCancelledMicrophone,
  createMicrophoneCaptureLifecycle,
  microphoneEchoMode,
  microphoneErrorKind,
  recoverableMicrophoneError,
} from '../src/realtime/microphone-capture.js'

class FakeEventTarget {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(listener)
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener)
  }

  emit(name) {
    for (const listener of this.listeners.get(name) || []) listener()
  }
}

class FakeTrack extends FakeEventTarget {
  constructor() {
    super()
    this.muted = false
    this.stopped = 0
  }

  stop() {
    this.stopped += 1
  }
}

function fakeClock() {
  let sequence = 0
  const timers = new Map()
  return {
    schedule(callback, delay) {
      const id = ++sequence
      timers.set(id, { callback, delay, id })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    runAll() {
      while (timers.size) {
        const next = [...timers.values()].sort((left, right) => (
          left.delay - right.delay || left.id - right.id
        ))[0]
        timers.delete(next.id)
        next.callback()
      }
    },
    size: () => timers.size,
  }
}

function capture(track = new FakeTrack()) {
  return {
    track,
    close() {
      track.stop()
    },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function fixture({ acquire, retryDelays = [1, 2] } = {}) {
  const mediaDevices = new FakeEventTarget()
  mediaDevices.getUserMedia = () => {}
  const clock = fakeClock()
  const captures = []
  const states = []
  const fatal = []
  const lifecycle = createMicrophoneCaptureLifecycle({
    mediaDevices,
    acquire: acquire || (async () => {
      const next = capture()
      captures.push(next)
      return next
    }),
    onState: state => states.push(state),
    onFatalError: error => fatal.push(error),
    retryDelays,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  return { captures, clock, fatal, lifecycle, mediaDevices, states }
}

test('coalesces device changes and reacquires the current default microphone', async () => {
  const target = fixture()
  target.lifecycle.start()
  await settle()
  assert.equal(target.captures.length, 1)

  target.mediaDevices.emit('devicechange')
  target.mediaDevices.emit('devicechange')
  target.mediaDevices.emit('devicechange')
  assert.equal(target.clock.size(), 1)
  target.clock.runAll()
  await settle()

  assert.equal(target.captures.length, 2)
  assert.equal(target.captures[0].track.stopped, 1)
  assert.deepEqual(
    target.states.map(state => state.state),
    ['starting', 'ready', 'recovering', 'ready'],
  )
  target.lifecycle.stop()
})

test('recovers an ended or persistently muted track and ignores a short mute', async () => {
  const target = fixture()
  target.lifecycle.start()
  await settle()
  const first = target.captures[0].track

  first.muted = true
  first.emit('mute')
  first.muted = false
  first.emit('unmute')
  target.clock.runAll()
  await settle()
  assert.equal(target.captures.length, 1)

  first.emit('ended')
  target.clock.runAll()
  await settle()
  assert.equal(target.captures.length, 2)

  const second = target.captures[1].track
  second.muted = true
  second.emit('mute')
  target.clock.runAll()
  await settle()
  assert.equal(target.captures.length, 3)
  target.lifecycle.stop()
})

test('keeps a missing replacement recoverable until another device appears', async () => {
  let attempts = 0
  const created = []
  const target = fixture({
    retryDelays: [1],
    acquire: async () => {
      attempts += 1
      if ([2, 3].includes(attempts)) {
        const error = new Error('no input device')
        error.name = 'NotFoundError'
        throw error
      }
      const next = capture()
      created.push(next)
      return next
    },
  })
  target.lifecycle.start()
  await settle()

  target.mediaDevices.emit('devicechange')
  target.clock.runAll()
  await settle()
  target.clock.runAll()
  await settle()
  assert.equal(target.states.at(-1).state, 'unavailable')
  assert.equal(target.states.at(-1).recoverable, true)

  target.mediaDevices.emit('devicechange')
  target.clock.runAll()
  await settle()
  assert.equal(attempts, 4)
  assert.equal(target.states.at(-1).state, 'ready')
  target.lifecycle.stop()
})

test('manual stop releases capture and prevents hot-plug reacquisition', async () => {
  const target = fixture()
  target.lifecycle.start()
  await settle()
  target.lifecycle.stop()
  assert.equal(target.captures[0].track.stopped, 1)

  target.mediaDevices.emit('devicechange')
  target.clock.runAll()
  await settle()
  assert.equal(target.captures.length, 1)
})

test('releases an acquisition that resolves after capture has stopped', async () => {
  let resolveAcquire
  const pending = new Promise(resolve => { resolveAcquire = resolve })
  const late = capture()
  const target = fixture({ acquire: () => pending })
  target.lifecycle.start()
  target.lifecycle.stop()
  resolveAcquire(late)
  await settle()
  assert.equal(late.track.stopped, 1)
})

test('treats denied permission as terminal and device absence as recoverable', async () => {
  assert.equal(recoverableMicrophoneError({ name: 'NotFoundError' }), true)
  assert.equal(recoverableMicrophoneError({ name: 'NotReadableError' }), true)
  assert.equal(recoverableMicrophoneError({ name: 'NotAllowedError' }), false)
  assert.equal(recoverableMicrophoneError({ name: 'NotSupportedError' }), false)

  const denied = new Error('permission denied')
  denied.name = 'NotAllowedError'
  const target = fixture({ acquire: async () => { throw denied } })
  target.lifecycle.start()
  await settle()
  assert.deepEqual(target.fatal, [denied])
  assert.equal(target.clock.size(), 0)
  target.lifecycle.stop()
})

test('normalizes native WebView microphone failures', () => {
  assert.equal(
    microphoneErrorKind({ name: 'NotAllowedError', message: 'Permission denied' }),
    'permission_denied',
  )
  assert.equal(microphoneErrorKind(new Error('permission denied')), 'permission_denied')
  assert.equal(microphoneErrorKind({ name: 'NotFoundError' }), 'device_missing')
  assert.equal(microphoneErrorKind({ name: 'NotReadableError' }), 'device_unavailable')
})


test('microphone uses mandatory system-wide echo cancellation', async () => {
  const requests = []
  const media = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: 'all' }) }] }
  const acquired = await acquireEchoCancelledMicrophone({
    getUserMedia: async request => { requests.push(request); return media },
  })
  assert.equal(acquired, media)
  assert.deepEqual(requests, [{ audio: {
    noiseSuppression: true, autoGainControl: true, echoCancellation: { exact: 'all' },
  } }])
  assert.equal(microphoneEchoMode(acquired), 'all')
})

test('unsupported all-audio constraint falls back to ordinary echo cancellation', async () => {
  const requests = []
  const media = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true }) }] }
  const acquired = await acquireEchoCancelledMicrophone({
    getUserMedia: async request => {
      requests.push(request)
      if (requests.length === 1) {
        throw Object.assign(new Error('Unsupported'), {
          name: 'OverconstrainedError', constraint: 'echoCancellation',
        })
      }
      return media
    },
  })
  assert.equal(acquired, media)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].audio.echoCancellation, true)
  assert.equal(microphoneEchoMode(acquired), 'default')
})

test('permission and device failures do not silently downgrade echo cancellation', async () => {
  for (const [name, constraint] of [
    ['NotAllowedError'], ['SecurityError'], ['NotReadableError'], ['TypeError'],
  ]) {
    let calls = 0
    const failure = Object.assign(new Error(name), { name, constraint })
    await assert.rejects(acquireEchoCancelledMicrophone({
      getUserMedia: async () => { calls++; throw failure },
    }), error => error === failure)
    assert.equal(calls, 1)
  }
})

test('microphone reports actual settings, not requested echo mode', () => {
  assert.equal(microphoneEchoMode({ getAudioTracks: () => [
    { getSettings: () => ({ echoCancellation: false }) },
  ] }), 'off')
  assert.equal(microphoneEchoMode({ getAudioTracks: () => [
    { getSettings: () => ({ echoCancellation: 'remote-only' }) },
  ] }), 'default')
  assert.equal(microphoneEchoMode({ getAudioTracks: () => [{}] }), 'unknown')
})


test('all-audio fallback handles engines reporting deviceId or missing constraint', async () => {
  for (const constraint of ['deviceId', undefined]) {
    let calls = 0
    const media = {}
    assert.equal(await acquireEchoCancelledMicrophone({
      getUserMedia: async request => {
        if (++calls === 1) throw Object.assign(new Error('Unsupported all'), {
          name: 'OverconstrainedError', constraint,
        })
        assert.equal(request.audio.echoCancellation, true)
        return media
      },
    }), media)
    assert.equal(calls, 2)
  }
})

test('device switching can recover using basic cancellation on the new input', async () => {
  let requests = 0
  const ready = []
  const f = fixture({ acquire: async () => {
    const media = await acquireEchoCancelledMicrophone({
      getUserMedia: async () => {
        if (++requests === 2) throw Object.assign(new Error('Unsupported all'), {
          name: 'OverconstrainedError', constraint: 'deviceId',
        })
        const mode = requests === 1 ? 'all' : true
        return { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: mode }) }] }
      },
    })
    ready.push(microphoneEchoMode(media))
    return capture()
  } })
  f.lifecycle.start()
  await new Promise(resolve => setImmediate(resolve))
  f.mediaDevices.emit('devicechange')
  f.clock.runAll()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ready, ['all', 'default'])
  assert.equal(f.states.at(-1).state, 'ready')
  f.lifecycle.stop()
})


test('capture mode is published only for the accepted device acquisition', async () => {
  const devices = new FakeEventTarget()
  devices.getUserMedia = () => {}
  const acquisitions = []
  const accepted = []
  const clock = fakeClock()
  const lifecycle = createMicrophoneCaptureLifecycle({
    mediaDevices: devices,
    schedule: clock.schedule,
    cancel: clock.cancel,
    acquire: () => new Promise(resolve => acquisitions.push(resolve)),
    onState: (state, activeCapture) => {
      if (state.state === 'ready') accepted.push(activeCapture)
    },
  })
  lifecycle.start()
  const pending = capture()
  lifecycle.restart('device-change')
  clock.runAll()
  const current = capture()
  acquisitions[1](current)
  await settle()
  acquisitions[0](pending)
  await settle()
  assert.deepEqual(accepted, [current])
  assert.equal(pending.track.stopped, 1)
  lifecycle.stop()
})

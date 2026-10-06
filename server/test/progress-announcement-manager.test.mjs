import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProgressAnnouncementManager,
} from '../src/voice/announcement/progress-announcement-manager.mjs'

function clock(start = 1) {
  let now = start
  let nextId = 0
  const timers = []
  const setTimer = (callback, delay) => {
    const timer = {
      id: ++nextId,
      at: now + delay,
      callback,
      cancelled: false,
      unref() {},
    }
    timers.push(timer)
    return timer
  }
  const clearTimer = timer => { timer.cancelled = true }
  const settle = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  const advance = async milliseconds => {
    const target = now + milliseconds
    while (true) {
      const next = timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!next) break
      next.cancelled = true
      now = next.at
      next.callback()
      await settle()
    }
    now = target
    await settle()
  }
  return { now: () => now, setTimer, clearTimer, advance }
}

function harness(options = {}) {
  const fakeClock = clock()
  const calls = []
  const active = new Set(['task_1', 'task_2'])
  let blocked = false
  let turnSequence = 0
  const manager = new ProgressAnnouncementManager({
    getFrontend: () => ({
      async injectResult(...args) {
        calls.push(args)
        return { completed: true }
      },
    }),
    isDeliveryBlocked: () => blocked,
    isTaskActive: taskId => active.has(taskId),
    intervalMs: 60_000,
    quietMs: 0,
    retryMs: 1_000,
    now: fakeClock.now,
    setTimer: fakeClock.setTimer,
    clearTimer: fakeClock.clearTimer,
    createTurnId: () => `gateway-turn-${++turnSequence}`,
    ...options,
  })
  return {
    manager,
    calls,
    active,
    advance: fakeClock.advance,
    now: fakeClock.now,
    setBlocked: value => { blocked = value },
  }
}

test('first real progress speaks at a text boundary without waiting a minute', async () => {
  const h = harness({ quietMs: 800 })
  h.manager.offer({ taskId: 'task_1', startedAt: h.now(), message: '正在读取' })
  await h.advance(300)
  h.manager.offer({ taskId: 'task_1', startedAt: 1, message: '正在读取资料' })
  await h.advance(499)
  assert.equal(h.calls.length, 0)
  await h.advance(1)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0][0], /正在读取资料/)
  assert.equal(h.calls[0][1], 'progress')
  assert.deepEqual(h.calls[0][2], { taskId: 'task_1', turnId: 'gateway-turn-1', taskIds: ['task_1'] })
  assert.match(h.calls[0][3].instructions, /阶段性更新，不是最终结果/)
  h.manager.close()
})

test('subsequent concurrent progress remains session-wide rate limited', async () => {
  const h = harness({ intervalMs: 20_000 })
  h.manager.offer({ taskId: 'task_1', message: '开始检查' })
  await h.advance(0)
  assert.equal(h.calls.length, 1)
  h.manager.offer({ taskId: 'task_2', message: '另一项工作的进展' })
  await h.advance(19_999)
  assert.equal(h.calls.length, 1)
  await h.advance(1)
  assert.equal(h.calls.length, 2)
  h.manager.close()
})

test('continuous streaming cannot defer the first progress indefinitely', async () => {
  const h = harness({ quietMs: 800 })
  h.manager.offer({ taskId: 'task_1', message: '开始整理' })
  await h.advance(600)
  h.manager.offer({ taskId: 'task_1', message: '持续整理中的最新文本' })
  await h.advance(199)
  assert.equal(h.calls.length, 0)
  await h.advance(1)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0][0], /持续整理中的最新文本/)
  h.manager.close()
})

test('drops pending progress when its task becomes terminal', async () => {
  const testHarness = harness()
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '即将被最终结果取代的更新',
  })
  testHarness.active.delete('task_1')
  testHarness.manager.remove('task_1')
  await testHarness.advance(60_000)
  assert.deepEqual(testHarness.calls, [])
  testHarness.manager.close()
})

test('waits while voice delivery is blocked without losing the latest update', async () => {
  const testHarness = harness()
  testHarness.setBlocked(true)
  testHarness.manager.offer({
    taskId: 'task_1',
    startedAt: 1,
    message: '等待合适的对话间隙',
  })
  await testHarness.advance(60_000)
  assert.equal(testHarness.calls.length, 0)
  testHarness.setBlocked(false)
  await testHarness.advance(1_000)
  assert.equal(testHarness.calls.length, 1)
  assert.match(testHarness.calls[0][0], /等待合适的对话间隙/)
  testHarness.manager.close()
})


test('voice reset removes the previous session cadence', async () => {
  const h = harness({ quietMs: 800 })
  h.manager.offer({ taskId: 'task_1', message: '前一会话进展' })
  await h.advance(800)
  assert.equal(h.calls.length, 1)
  h.manager.clear()
  h.manager.offer({ taskId: 'task_2', message: '新的真实进展' })
  await h.advance(800)
  assert.equal(h.calls.length, 2)
  h.manager.close()
})

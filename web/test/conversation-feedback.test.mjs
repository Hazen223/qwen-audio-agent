import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationFeedback, presentTaskResult, recoverConversationFeedback, visibleConversationMessages } from '../src/conversation-feedback.js'

test('accepted manual input acknowledges immediately before the server turn arrives', () => {
  let state = conversationFeedback(null, { type: 'input.submitted' })
  assert.equal(state.phase, 'received')
  state = conversationFeedback(state, { type: 'turn.started', turnId: 't1' })
  assert.equal(state.turnId, 't1')
  state = conversationFeedback(state, { type: 'transcript.final', role: 'user', turnId: 't1', content: '查一下资料' })
  assert.equal(state.phase, 'thinking')
  assert.equal(conversationFeedback(state, { type: 'transcript.delta', role: 'assistant', turnId: 't1', content: '结果' }), null)
})

test('background progress and stale responses cannot clear or replace current thinking', () => {
  const state = { turnId: 't2', phase: 'thinking' }
  for (const event of [
    { type: 'transcript.final', role: 'assistant', origin: 'progress', turnId: 't2', content: '正在读取' },
    { type: 'task.completed', task: { turnId: 't1' } },
    { type: 'voice.state', state: 'processing', origin: 'model', turnId: 't1' },
    { type: 'transcript.final', role: 'user', turnId: 't1', content: '旧轮' },
  ])  assert.strictEqual(conversationFeedback(state, event, 't2'), state)
})

test('interrupt, disconnect, error, reset and task acceptance stop the matching indicator', () => {
  const state = { turnId: 't1', phase: 'thinking' }
  for (const event of [
    { type: 'response.interrupted', turnId: 't1' },
    { type: 'transcript.discard', turnId: 't1', role: 'user' },
    { type: 'gateway.disconnected' }, { type: 'error' }, { type: 'session.reset' },
    { type: 'task.accepted', task: { turnId: 't1' } },
    { type: 'voice.state', state: 'idle', turnId: 't1' },
  ]) assert.equal(conversationFeedback(state, event), null)
})

test('completion proactively presents full result without asking or polling; replay is idempotent', () => {
  const task = { id: 'a', status: 'completed', result: '**完成**\n全部结果', turnId: 't1' }
  const messages = presentTaskResult([{ id: 'u', role: 'user', turnId: 't1', content: '帮我检查' }], task)
  assert.equal(messages[1].content, '**完成**\n全部结果')
  assert.strictEqual(presentTaskResult(messages, task), messages)
  const withSpeech = [...messages, { id: 'voice:a', origin: 'announcement', content: '简短总结', taskIds: ['a'] }]
  assert.deepEqual(visibleConversationMessages(withSpeech), messages)
  assert.equal(visibleConversationMessages([...withSpeech, { origin: 'progress', taskIds: ['a'] }]).length, 3)
})

test('recovered results, combined announcements, errors and cancellation remain truthful', () => {
  const task = { id: 'a', status: 'completed', result: '完成' }
  const recovered = [{ id: 'old', source: 'agent-result', taskId: 'a', content: '完成' }]
  assert.strictEqual(presentTaskResult(recovered, task), recovered)
  const combined = { origin: 'announcement', taskIds: ['a', 'b'], content: 'A与B' }
  assert.equal(visibleConversationMessages([...recovered, combined]).length, 2)
  assert.equal(presentTaskResult([], { ...task, status: 'failed', error: '服务不可用' })[0].content, '服务不可用')
  assert.deepEqual(presentTaskResult([], { ...task, status: 'cancelled' }), [])
})


test('provider loss, takeover, recovery and replay never strand a thinking bubble', () => {
  const state = { turnId: 't1', phase: 'thinking' }
  for (const event of [
    { type: 'voice.state', state: 'idle' },
    { type: 'voice.deactivated' }, { type: 'session.recovered' },
    { type: 'voice.connection', state: 'unavailable' },
    { type: 'voice.ownership', state: 'busy' },
  ]) assert.equal(conversationFeedback(state, event), null)
  assert.equal(conversationFeedback(null, { type: 'voice.state', state: 'processing', replayed: true, turnId: 'old' }), null)
})


test('recovery only adds pending results and never resurrects previously delivered old tasks', () => {
  const tasks = [
    { id: 'old', status: 'completed', notificationStatus: 'delivered', result: '旧任务结果' },
    { id: 'new', status: 'completed', notificationStatus: 'pending', result: '离线期间刚完成的结果' },
  ]
  const history = [{ id: 'u', role: 'user', content: '当前问题', turnId: 't1' }]
  const messages = recoverConversationFeedback([], history, tasks)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].taskId, 'new')
  assert.deepEqual(recoverConversationFeedback(messages, history, tasks), messages)
})

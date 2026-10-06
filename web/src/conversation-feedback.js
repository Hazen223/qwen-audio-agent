import { taskNeedsPresentation } from './task-view.js'
import { mergeConversationHistory, insertByTurn } from './message-order.js'

// Ephemeral presentation only: never injected into the model's conversation.
export function conversationFeedback(current, event, activeTurnId = '') {
  if (event.replayed) return current
  if (event.type === 'input.submitted') return { turnId: '', phase: 'received' }
  if (event.type === 'turn.started') return current?.turnId === ''
    ? { ...current, turnId: event.turnId } : null
  if (activeTurnId && event.turnId && event.turnId !== activeTurnId
    && !['progress', 'announcement', 'permission', 'backend-input'].includes(event.origin)) return current
  if (event.type === 'transcript.final' && event.role === 'user') {
    return event.content?.trim() ? { turnId: event.turnId, phase: 'thinking' } : current
  }
  if (['gateway.disconnected', 'voice.deactivated', 'session.recovered', 'error', 'session.reset'].includes(event.type)) return null
  if (event.type === 'voice.connection' && ['unavailable', 'disconnected', 'failed'].includes(event.state)) return null
  if (event.type === 'voice.ownership' && event.state === 'busy') return null
  if (event.type === 'voice.state' && event.state === 'idle' && !event.turnId
    && (!event.origin || event.origin === 'model')) return null
  const sameTurn = current && event.turnId === current.turnId
  if (event.type === 'voice.state' && event.state === 'processing'
    && (!event.origin || event.origin === 'model')) {
    return { turnId: event.turnId, phase: 'thinking' }
  }
  if (sameTurn && event.type === 'voice.state' && event.state === 'idle'
    && (!event.origin || event.origin === 'model')) return null
  if (sameTurn && ['response.interrupted', 'transcript.discard'].includes(event.type)) return null
  if (sameTurn && event.type.startsWith('transcript.') && event.role === 'assistant'
    && !['progress', 'announcement', 'permission', 'backend-input'].includes(event.origin)
    && event.content?.trim()) return null
  if (current && event.task?.turnId === current.turnId
    && ['task.accepted', 'task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) return null
  return current
}

export function presentTaskResult(messages, task) {
  if (!task?.id || !['completed', 'failed'].includes(task.status)) return messages
  const content = String(task.status === 'failed' ? task.error || '' : task.result || '').trim()
  if (!content) return messages
  // Replays and recovered agent-result history must not duplicate a result.
  if (messages.some(message => message.id === `task-result:${task.id}`
    || (message.source === 'agent-result' && message.taskId === task.id))) return messages
  return insertByTurn(messages, {
    id: `task-result:${task.id}`,
    role: 'assistant',
    content,
    turnId: task.turnId || '',
    taskId: task.id,
    taskIds: [task.id],
    source: 'agent-result',
    origin: 'task-result',
    companion: true,
    live: false,
  })
}

export function visibleConversationMessages(messages) {
  const results = new Set(messages.filter(message => message.source === 'agent-result')
    .flatMap(message => message.taskIds?.length ? message.taskIds : [message.taskId].filter(Boolean)))
  // Audio still plays normally; retain the full factual result rather than a
  // second, model-generated summary of the same completed work.
  return messages.filter(message => {
    if (message.origin !== 'announcement' && message.source !== 'agent-presentation') return true
    const ids = message.taskIds?.length ? message.taskIds : [message.taskId].filter(Boolean)
    return !ids.length || !ids.every(id => results.has(id))
  })
}

export function recoverConversationFeedback(messages, history, tasks) {
  return tasks.filter(taskNeedsPresentation).reduce(presentTaskResult, mergeConversationHistory(messages, history))
}

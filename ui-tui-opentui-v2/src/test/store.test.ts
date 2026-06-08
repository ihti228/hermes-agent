/**
 * Phase 0 store reducer test (spec v4 §5 Layer 3). Pure data behavior of
 * `apply(event)` — no renderer, no Effect. Drives the scripted hello stream and
 * asserts the streamed assistant text concatenates and finalizes.
 */
import { describe, expect, test } from 'bun:test'

import { createSessionStore } from '../logic/store.ts'

describe('session store reducer (Phase 0)', () => {
  test('gateway.ready flips ready', () => {
    const store = createSessionStore()
    expect(store.state.ready).toBe(false)
    store.apply({ type: 'gateway.ready' })
    expect(store.state.ready).toBe(true)
  })

  test('message.start/delta/complete streams one assistant message', () => {
    const store = createSessionStore()
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'Hi ' } })
    store.apply({ type: 'message.delta', payload: { text: 'there, ' } })
    store.apply({ type: 'message.delta', payload: { text: 'glitch!' } })

    expect(store.state.messages.length).toBe(1)
    const live = store.state.messages[0]!
    expect(live.role).toBe('assistant')
    expect(live.text).toBe('Hi there, glitch!')
    expect(live.streaming).toBe(true)

    store.apply({ type: 'message.complete' })
    expect(store.state.messages[0]!.streaming).toBe(false)
    expect(store.state.messages[0]!.text).toBe('Hi there, glitch!')
  })

  test('pushUser appends a user message', () => {
    const store = createSessionStore()
    store.pushUser('hello')
    expect(store.state.messages.length).toBe(1)
    expect(store.state.messages[0]!.role).toBe('user')
    expect(store.state.messages[0]!.text).toBe('hello')
  })
})

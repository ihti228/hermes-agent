/**
 * Phase 0 render test (spec v4 §5 Layer 2). Mounts the App headlessly with a
 * store seeded by the scripted hello stream and asserts the captured frame
 * contains the rendered text. This is the headless frame gate for Phase 0.
 */
import { describe, expect, test } from 'bun:test'

import { createSessionStore } from '../logic/store.ts'
import { captureFrame } from './lib/render.ts'
import { App } from '../view/App.tsx'

describe('App render (Phase 0)', () => {
  test('renders the streamed hello + ready header into the frame', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ type: 'message.delta', payload: { text: 'Hi there, glitch!' } })
    store.apply({ type: 'message.complete' })

    const frame = await captureFrame(() => <App store={store} />, { width: 60, height: 8 })

    expect(frame).toContain('hermes')
    expect(frame).toContain('ready')
    expect(frame).toContain('Hi there, glitch!')
  })
})

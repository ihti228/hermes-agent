/**
 * StatusLine timer-lifecycle invariant (skins-spec §5b gate): the animated busy
 * indicator's interval MUST be ARMED only while info.running and CLEARED when it
 * flips false / on unmount — never a permanent timer (which would fight the
 * windowing poll + defeat idle-GC). Asserted by spying setInterval/clearInterval
 * around the store's running flag and checking the armed/cleared balance.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { StatusLine } from '../view/statusLine.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

describe('StatusLine — spinner timer lifecycle (no permanent timer)', () => {
  let probe: RenderProbe | undefined
  afterEach(() => {
    probe?.destroy()
    probe = undefined
    vi.restoreAllMocks()
  })

  test('interval armed only while info.running; cleared when it flips false', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const store = createSessionStore()

    probe = await renderProbe(() => (
      <ThemeProvider theme={() => store.state.theme}>
        <StatusLine store={store} />
      </ThemeProvider>
    ))

    const armedAtIdle = setSpy.mock.calls.length // idle: no spinner interval

    store.apply({ type: 'message.start' })
    await probe.settle()
    const armedRunning = setSpy.mock.calls.length
    expect(armedRunning).toBeGreaterThan(armedAtIdle) // a timer was armed on running

    const clearedBefore = clearSpy.mock.calls.length
    store.apply({ type: 'message.complete', payload: { text: 'done' } })
    await probe.settle()
    // flipping running false disposes the prior effect-run → clearInterval fires
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore)
  })
})

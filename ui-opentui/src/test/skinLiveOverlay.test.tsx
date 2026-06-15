/**
 * Skin live re-theme — overlay/popup coverage.
 *
 * IMPORTANT (false-confidence caveat, learned from adversarial review): the
 * headless test renderer FORCE-FLUSHES every frame (`renderProbe`/`settle` call
 * renderOnce+flush), so a `captureSpans()` assertion that "the dropdown bg
 * changed after skin.changed" passes EVEN IF the live native-repaint nudge is
 * reverted — it proves the reactive DATA pipeline, NOT the live repaint. The
 * actual live popup-repaint bug (popups keep old colors until restart) is a
 * native-renderer flush issue the headless renderer cannot reproduce. So:
 *   - test 1 asserts the reactivity pipeline (honest scope: data, not repaint).
 *   - test 2 asserts real skins drive distinct status/completion backgrounds.
 *
 * NOTE: the live popup-repaint fix (header.tsx requestRender on skin change) is
 * NOT guarded by an automated test — it is fundamentally not headless-testable
 * (the windowing frame loop already calls requestRender ~60x/frame, so a spy
 * cannot isolate the skin nudge). It needs a live-tmux smoke to verify.
 */
import type { RGBA } from '@opentui/core'
import { describe, expect, test } from 'vitest'

import { createPromptHistory } from '../logic/history.ts'
import { planCompletion } from '../logic/slash.ts'
import { createSessionStore, type CompletionItem } from '../logic/store.ts'
import { fromSkin as fromSkinReal } from '../logic/theme.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

const CATALOG: CompletionItem[] = [
  { display: '/clear', meta: 'clear', text: '/clear' },
  { display: '/commit', meta: 'commit', text: '/commit' },
  { display: '/copy', meta: 'copy', text: '/copy' }
]

function hex(c: RGBA): string {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
}

async function mount(store: ReturnType<typeof createSessionStore>) {
  const history = createPromptHistory({ initial: [] })
  const onType = (text: string) => {
    const plan = planCompletion(text)
    if (!plan || plan.method !== 'complete.slash') return store.clearCompletions()
    const q = String(plan.params.text).toLowerCase()
    const items = CATALOG.filter(c => c.text.startsWith(q) && c.text !== q)
    if (items.length) store.setCompletions(items, plan.from)
    else store.clearCompletions()
  }
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} onSubmit={() => {}} onType={onType} history={history} />
      </ThemeProvider>
    ),
    { height: 24, kittyKeyboard: true, width: 70 }
  )
}

describe('skin.changed re-themes the dropdown — reactivity pipeline (NOT live repaint)', () => {
  test('dropdown row bg reflects the new completion_menu_bg after skin.changed', async () => {
    // Honest scope: proves skin.changed → theme signal → dropdown binding. Does
    // NOT prove the live native repaint (the harness force-flushes — see header).
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    const probe = await mount(store)
    try {
      await probe.keys.typeText('/c')
      await probe.settle()
      store.apply({
        type: 'skin.changed',
        payload: { colors: { completion_menu_bg: '#123456', completion_menu_current_bg: '#654321' } }
      })
      await probe.settle()
      const bgs = new Set<string>()
      for (const line of probe.spans().lines) {
        for (const s of line.spans) {
          if (/\/c(lear|ommit|opy)/.test(s.text) && s.bg) bgs.add(hex(s.bg))
        }
      }
      expect(bgs.has('#123456')).toBe(true)
    } finally {
      probe.destroy()
    }
  })
})

describe('real skins drive status/completion backgrounds (fix A)', () => {
  test('status_bar_bg + completion differ across ares/poseidon (not all #1a1a2e)', () => {
    const ares = fromSkinReal({ status_bar_bg: '#2A1212', banner_accent: '#DD4A3A', completion_menu_bg: '#2A1212' }, {})
    const pos = fromSkinReal({ status_bar_bg: '#0F2440', banner_accent: '#5DB8F5', completion_menu_bg: '#0F2440' }, {})
    expect(ares.color.statusBg).toBe('#2A1212')
    expect(pos.color.statusBg).toBe('#0F2440')
    expect(ares.color.statusBg).not.toBe(pos.color.statusBg)
    expect(ares.color.completionBg).not.toBe(pos.color.completionBg)
  })
})

/**
 * Entry — the single boundary edge (spec v4 §3.1). This is the ONE place that:
 *   - acquires the renderer (acquireRelease + Deferred-on-destroy),
 *   - creates the Solid store,
 *   - wires GatewayService.subscribe -> store.apply  (Effect->Solid contact #2),
 *   - does the one-line `render(() => <App/>, renderer)` bridge (contact #1),
 *   - blocks until the renderer is destroyed (user quit),
 * and at the bottom PROVIDES the layers and runs (`Effect.provide(AppLayer)`).
 *
 * Phase 0 backend = FakeGateway, which streams a scripted "hello". Phase 1
 * swaps `liveGateway.layer` for the real `tui_gateway` transport. The body of
 * `run` does not change when the backend swaps — that's the point of the layer.
 */
import { render } from '@opentui/solid'
import { Deferred, Effect } from 'effect'

import { GatewayService } from '../boundary/gateway/GatewayService.ts'
import { acquireRenderer } from '../boundary/renderer.ts'
import { makeAppLayer } from '../boundary/runtime.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { makeFakeGatewayLayer, type FakeGatewayController } from './fakeGateway.ts'

export interface TuiInput {
  readonly mouse: boolean
}

/** The entry Effect. Mirrors opencode `app.tsx:177` `run = Effect.fn("Tui.run")`. */
export const run = Effect.fn('Tui.run')(function* (input: TuiInput) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const { renderer, shutdown } = yield* acquireRenderer({ mouse: input.mouse })

      // Solid side: the store + reducer. Created here, lives in Solid-land.
      const store = createSessionStore()

      // Contact point #2: boundary pushes decoded events into the Solid store.
      const gateway = yield* GatewayService
      yield* gateway.subscribe(event => store.apply(event))

      // Contact point #1: the single render bridge. After this, the screen is Solid's.
      yield* Effect.promise(() => render(() => <App store={store} />, renderer))

      // Block until the renderer is destroyed (Ctrl+C / quit); finalizers then run.
      yield* Deferred.await(shutdown)
    })
  )
})

/** Scripted "hello" stream so Phase 0 paints a non-empty frame from the fake backend. */
function streamHello(controller: FakeGatewayController): void {
  controller.emit({ type: 'gateway.ready' })
  controller.emit({ type: 'message.start' })
  for (const chunk of ['Hi ', 'there, ', 'glitch!']) {
    controller.emit({ type: 'message.delta', payload: { text: chunk } })
  }
  controller.emit({ type: 'message.complete' })
}

if (import.meta.main) {
  const { layer, controller } = makeFakeGatewayLayer()
  // Drive the fake stream shortly after mount so the subscription is live.
  setTimeout(() => streamHello(controller), 50)
  Effect.runPromise(run({ mouse: false }).pipe(Effect.provide(makeAppLayer(layer)))).catch(error => {
    console.error('[tui] fatal', error)
    process.exitCode = 1
  })
}

/**
 * Phase 0 boundary test (spec v4 §5 Layer 1). Exercises the GatewayService
 * shape through the FakeGateway layer using the bun-test Effect helper:
 * subscribe receives emitted events; request records the call. Proves the
 * Effect<->Solid seam (subscribe) and the typed request path compile + run.
 */
import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { GatewayService } from '../boundary/gateway/GatewayService.ts'
import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'
import { makeFakeGateway, fakeGatewayLayerWith } from '../entry/fakeGateway.ts'
import { testLayer } from './lib/effect.ts'

describe('GatewayService via FakeGateway (Phase 0)', () => {
  test('subscribe receives emitted events; request records the call', async () => {
    const controller = makeFakeGateway('sess-123')
    const layer = fakeGatewayLayerWith(controller)

    const received: GatewayEvent[] = []

    const program = Effect.gen(function* () {
      const gateway = yield* GatewayService
      const unsubscribe = yield* gateway.subscribe(event => received.push(event))
      // Emit after subscribing (synchronous fan-out in the fake).
      controller.emit({ type: 'gateway.ready' })
      controller.emit({ type: 'message.start' })
      yield* gateway.request('prompt.submit', { text: 'hi' })
      unsubscribe()
      controller.emit({ type: 'message.complete' }) // dropped: unsubscribed
      return gateway.sessionId()
    })

    const sessionId = await testLayer(layer, program)

    expect(sessionId).toBe('sess-123')
    expect(received.map(e => e.type)).toEqual(['gateway.ready', 'message.start'])
    expect(controller.calls).toEqual([{ method: 'prompt.submit', params: { text: 'hi' } }])
  })
})

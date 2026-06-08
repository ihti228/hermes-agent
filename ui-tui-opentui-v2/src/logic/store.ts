/**
 * Session/message store — the SOLID side (spec v4 §1). Plain `createStore` +
 * an `apply(event)` reducer, à la opencode `context/sync-v2.tsx`. NOT Effect:
 * this is where reactivity lives. The boundary calls `apply` with already-decoded
 * GatewayEvents via GatewayService.subscribe.
 *
 * Phase 0: the minimal reducer needed to render a streamed "hello" (start →
 * delta → complete). Phase 1 grows this into the full ordered-parts model
 * (spec v4 §7): LRU id dedup, hydrate-while-buffering, text/tool/reasoning parts.
 */
import { createStore, produce } from 'solid-js/store'

import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'

export interface Message {
  readonly role: 'user' | 'assistant' | 'system'
  text: string
  streaming?: boolean
}

export interface StoreState {
  ready: boolean
  messages: Message[]
}

export function createSessionStore() {
  const [state, setState] = createStore<StoreState>({ ready: false, messages: [] })

  /** Push a user message (composer submit). */
  function pushUser(text: string) {
    setState(
      produce(draft => {
        draft.messages.push({ role: 'user', text })
      })
    )
  }

  /** Reduce a decoded gateway event into the store. The sole boundary->Solid sink. */
  function apply(event: GatewayEvent): void {
    switch (event.type) {
      case 'gateway.ready':
        setState('ready', true)
        break
      case 'message.start':
        setState(
          produce(draft => {
            draft.messages.push({ role: 'assistant', text: '', streaming: true })
          })
        )
        break
      case 'message.delta': {
        const text = event.payload?.text ?? ''
        if (!text) break
        setState(
          produce(draft => {
            const live = draft.messages[draft.messages.length - 1]
            // prefer `text` over `rendered` (gotcha §8 #4) — placeholder only carries text.
            if (live && live.role === 'assistant' && live.streaming) live.text += text
          })
        )
        break
      }
      case 'message.complete':
        setState(
          produce(draft => {
            const live = draft.messages[draft.messages.length - 1]
            if (live && live.role === 'assistant' && live.streaming) {
              const finalText = event.payload?.text
              if (finalText) live.text = finalText
              live.streaming = false
            }
          })
        )
        break
    }
  }

  return { state, apply, pushUser } as const
}

export type SessionStore = ReturnType<typeof createSessionStore>

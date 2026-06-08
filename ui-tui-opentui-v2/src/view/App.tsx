/**
 * App — the Solid view shell (spec v4 §2 `view/App.tsx`). Phase 0 is a minimal
 * skeleton: a header line + a transcript of messages from the store. It renders
 * the scripted "hello" stream the FakeGateway emits.
 *
 * The store is created in the entry (Solid side) and the boundary subscribes the
 * store's `apply` to the GatewayService event stream — the only boundary->Solid
 * contact point besides `render`.
 *
 * Rich text uses <b>/<span> children, never an attributes bitmask (gotcha §8 #1).
 * Inline color goes in `style={{ fg }}` on <span>; <text> accepts `fg` directly
 * (verified against @opentui/solid@0.3.2 SpanProps/TextProps + opencode usage).
 */
import { For, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'

export interface AppProps {
  readonly store: SessionStore
}

export function App(props: AppProps) {
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <box style={{ flexShrink: 0 }}>
        <text>
          <b>hermes</b>
          <span> · opentui · </span>
          <Show when={props.store.state.ready} fallback={<span style={{ fg: '#888888' }}>connecting…</span>}>
            <span style={{ fg: '#8BD5CA' }}>ready</span>
          </Show>
        </text>
      </box>
      <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, marginTop: 1 }}>
        <For each={props.store.state.messages}>
          {message => (
            <text>
              <span style={{ fg: message.role === 'assistant' ? '#8BD5CA' : '#C6A0F6' }}>
                {message.role === 'assistant' ? '✦ ' : '> '}
              </span>
              <span>{message.text}</span>
              <Show when={message.streaming}>
                <span style={{ fg: '#888888' }}>▍</span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

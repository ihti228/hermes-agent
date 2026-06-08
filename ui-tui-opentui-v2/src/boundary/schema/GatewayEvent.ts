/**
 * GatewayEvent — the decoded wire union pushed from the boundary into the Solid store.
 *
 * Phase 0: a MINIMAL hand-typed placeholder covering only what the "hello" smoke
 * needs (`gateway.ready`, `message.start/delta/complete`). Phase 1 replaces this
 * with the full ~40-member union modeled as `Schema.Class` members +
 * `Schema.toTaggedUnion("type")`, decoded from unknown wire JSON ONCE at the
 * transport boundary (spec v4 §3.3). The discriminant is always `type`, matching
 * Ink's `ui-tui/src/gatewayTypes.ts:509-587`.
 */

export type GatewayEvent =
  | { readonly type: 'gateway.ready'; readonly session_id?: string }
  | { readonly type: 'message.start'; readonly session_id?: string }
  | { readonly type: 'message.delta'; readonly payload?: { readonly text?: string }; readonly session_id?: string }
  | { readonly type: 'message.complete'; readonly payload?: { readonly text?: string }; readonly session_id?: string }

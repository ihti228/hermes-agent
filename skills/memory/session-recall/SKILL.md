---
name: session-recall
description: Use session_search effectively for finding and reading prior Hermes sessions.
metadata:
  hermes:
    category: memory
---

# session-recall

session_search is the tool. Three modes — fast, guided, summary — answer different question shapes. Picking the wrong mode costs latency, money, or correctness.

## Pre-flight

1. If the user asks about prior work ("find the session where X", "catch me up on Y", "we drafted Z"), your first move is session_search. Not filesystem search, not a different tool.
2. If the user names an artefact, search the literal name first. No OR-expansion.
3. Default to fast → guided. Reach for summary only when you need cross-session synthesis prose in one shot.

## Mode picker

| Question shape | Mode | Why |
|---|---|---|
| Catch me up / where did we get to / what did we decide | fast → guided | FTS5 finds sessions; guided reads the transcript. SQL-only. |
| Find an artefact by name / which session mentions X | fast | Snippets only, no LLM. |
| Read around a specific message in a known session | guided | Raw window around anchor. |
| Cross-session prose synthesis in one shot | summary | LLM call per hit (aux model if configured, else main). Opt-in. |

## Levers

| Lever | Default | When to change |
|---|---|---|
| `limit` (fast) | 3 | 5–10 when topic spans sessions or user wants to pick from a list |
| `sort` (fast) | unset (relevance) | `newest` for "where did we leave X"; `oldest` for "how did X start" |
| `role_filter` (fast) | user,assistant | Add `tool` only when debugging tool output specifically |
| `window` (guided) | 5 | Bump for long resolutions; shrink if response truncates |
| anchor count (guided) | 1 | 2–3 anchors when topic spans recent sessions |
| `limit` (summary) | 3 | Bump cautiously; cost scales directly |

## Composition patterns

1. **Discover → drill.** fast first, drill the top hit with guided. Widen `window` or re-anchor if the resolution isn't covered.
2. **Multi-anchor for arcs.** When fast returns 2–3 relevant hits on the same topic, pass them all to guided in one call.
3. **Bookend-first reading.** For "what was the conclusion" questions, read `bookend_end` before `messages`.
4. **Delegate when transcripts are big.** If you're about to pull 30K+ chars of transcript into your context just to summarise it, hand the dumps to a subagent and ask for a digest.
5. **Verify before quoting.** High-stakes recall does two passes: fast with the literal term (does the hit list contain the right session?) → guided (does the transcript confirm the outcome?).

## Worked examples

### A — find a named artefact

User: "we drafted a deployment plan in a session yesterday, find it"

Right: `session_search(query="deployment plan", limit=5)`. The user named it — search the name. Drill the top hit if you need details.

Wrong: `session_search(query="deploy OR deployment OR rollout OR plan")`. OR-expansion drowns the hit in unrelated sessions.

### B — catch up on a multi-session arc

User: "where did we get to with the auth refactor?"

Right: fast with `sort='newest'`, then multi-anchor guided across the top 2–3 hits:

```
session_search(query="auth refactor", limit=5, sort='newest')
session_search(mode='guided', anchors=[
  {'session_id': hit_1.session_id, 'around_message_id': hit_1.match_message_id},
  {'session_id': hit_2.session_id, 'around_message_id': hit_2.match_message_id},
  {'session_id': hit_3.session_id, 'around_message_id': hit_3.match_message_id},
])
```

Read all three slices (bookend_start / messages / bookend_end) on each window and the arc reconstructs.

Wrong: `session_search(query="auth refactor", mode='summary')`. Summary launders FTS5 hits through an LLM and can confabulate when the right session isn't in the hit list.

### C — drill into a known session for a conclusion

User: "in the session about the caching layer, what did we decide?"

fast to locate, guided to drill, read `bookend_end` first:

```
session_search(query="caching layer", limit=3)
session_search(mode='guided', anchors=[
  {'session_id': <top>, 'around_message_id': <match_id>}
])
```

Conclusions ("decided X", "shipped Y") usually live in `bookend_end`.

## Reading guided responses

Every guided window has three slices:

- `bookend_start` — opening prose (kickoff, goal)
- `messages` — the anchored window (FTS5 hit + neighbours)
- `bookend_end` — closing prose (resolution, decisions, commits)

Read all three. Bookends are prose that summarises; snippets and the middle window can be noisy when sessions are *about* the search term.

## Pitfalls

- **Manual-archaeology trap.** If fast snippets look noisy, drill the top hit with guided. Don't pivot to find / grep / raw SQL.
- **Summary confabulation.** Summary will produce confident prose even when FTS5 missed the right session. Verify by re-querying in fast mode and checking the hit list.
- **FTS5 is AND by default.** Multi-word queries require all terms; use OR or quoted phrases deliberately.
- **Anchor mismatch.** `around_message_id` must exist in the named session. Re-anchor from a fresh fast result if guided rejects.
- **Window truncation.** Re-call with a smaller window if a dump truncates.
- **Compaction lineage.** A fast hit with `parent_session_id` set means the session was split by compaction; its `bookend_start` is a handoff summary, not the original opener.

## Note on skill limits

This skill teaches composition but cannot enforce it. If your default behaviour drifts — composing paraphrase queries instead of drilling, reaching for summary when fast → guided would do, pivoting to filesystem search when fast returned hits — the skill is being ignored, not failing. When in doubt: fast first, then drill.

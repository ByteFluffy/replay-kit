# Replay Protocol v1

## 1. Core Principles

1. **The engine is payload-blind.** Events carry opaque `data` routed to host-implemented channel adapters. Channels declare a versioned `format` string (e.g. `kv@1`), and adapters declare which `formats` they accept.
2. **Segments are keyframes.** Long sessions are split into self-contained segments. Each segment starts with a full `initialState` baseline captured from all stateful channels, making every segment independently playable and giving `O(log K + Δ)` seek latency when joined.
3. **Host owns I/O and UI.** `replay-kit-core` has zero runtime dependencies and no DOM/Node assumptions. Fetching, uploading, storage, and rendering belong to the host.

## 2. Data Model

### `ReplayBundle`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `v` | `1` | yes | Protocol major version. Unknown versions are rejected. |
| `id` | `string` | yes | Session or bundle identifier. |
| `host` | `string` | yes | Producer identifier (informational only). |
| `title` | `string` | no | Human-readable label. |
| `channels` | `Record<string, { format: string }>` | yes | Declared channels and their payload formats. |
| `originMs` | `number` | no | Timeline origin in ms (default `0`). Events must have `t >= originMs`. |
| `segment` | `{ index: number; baseSeq: number; final?: boolean }` | no | Segment metadata for multi-part sessions. |
| `playback` | `{ maxIdleGapMs?: number; compressedGapMs?: number; speed?: number }` | no | Idle compression & default speed (`1800`, `900`, `1`). |
| `meta` | `Record<string, unknown>` | no | Opaque host metadata (app version, template id, etc.). |
| `initialState` | `Record<string, unknown>` | yes | Per-channel state before `events[0]`. Use `null` for stateless channels. |
| `keyframes` | `{ seq: number; state: Record<string, unknown> }[]` | no | Snapshots after applying `events[0..seq]`, strictly ascending `seq`. |
| `events` | `ReplayEvent[]` | yes | Ordered event stream (`seq` is the 0-based array index). |

### `ReplayEvent`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `t` | `number` | yes | Timestamp in ms, monotonically non-decreasing across the bundle. |
| `ch` | `string` | yes | Channel name declared in `channels`. |
| `k` | `string` | no | Kind tag for adapter/UI display (ignored by the engine). |
| `data` | `unknown` | no | Channel-private, JSON-serializable payload. |
| `step` | `true` | no | Marks semantic milestones for `step(+1)` / `step(-1)`. |
| `corr` | `string` | no | Cross-channel causal correlation key. |
| `sev` | `'warn' \| 'error'` | no | Severity marker for timeline highlighting. |
| `id` | `string` | no | Unique identifier for `seek({ eventId })`. |

Unknown fields are ignored for forward compatibility; unknown `v` is rejected. Events on channels without a registered adapter are skipped silently.

## 3. JSONL Wire Format

Line 1 is the header object (`"type": "header"` plus bundle fields excluding `events` and `keyframes`). Subsequent lines are events, optionally interleaved with inline keyframe lines (`"type": "keyframe"`) placed immediately after the event at `seq`:

```jsonl
{"type":"header","v":1,"id":"s1","host":"demo","channels":{"doc":{"format":"kv@1"}},"initialState":{"doc":{}}}
{"t":0,"ch":"doc","k":"set","step":true,"data":{"k":"a","v":1}}
{"type":"keyframe","seq":0,"state":{"doc":{"a":1}}}
```

`decodeJsonl(text, { tolerateTruncatedTail: true })` discards an unparseable final line so interrupted open segments remain readable.

## 4. Segmentation & Joining

- Segments carry `segment: { index, baseSeq, final? }`. `index` starts at `0` and increments by `1`; `baseSeq` equals the total event count of all preceding segments.
- For segment `i >= 1`, `initialState` holds the captured state immediately after the last event of segment `i - 1`, and `originMs` holds that boundary's `t`.
- `joinSegments(segments)` validates alignment, concatenates `events`, turns each `S_i.initialState` (`i >= 1`) into a keyframe at `baseSeq - 1`, shifts segment-local keyframes by `baseSeq`, strips `segment`, and returns one playable `ReplayBundle`.

## 5. Channel Adapter Contract (`IReplayChannel`)

- `reset(initial, ctx)`: restore pre-`events[0]` state.
- `apply(event, ctx)`: synchronously apply one event to host state.
- `restore?(snapshot, ctx)`: jump directly to a keyframe snapshot (if omitted, the engine falls back to `reset` + replaying that channel's events up to the baseline).
- `applyBatch?(events, ctx)`: optional batch optimization for consecutive same-channel events.
- `onSeekPhase?('start' | 'end')`: brackets non-incremental seeks so heavy render/decode work can defer until `'end'`.
- `capture?()`: returns a serializable baseline snapshot for `ReplayRecorder` (`null` for stateless channels).

## 6. Recorder Contract (`ReplayRecorder`)

- **Record after mutate**: hosts update their own state first, then call `recorder.record(...)`, ensuring segment-boundary `capture()` reflects the post-event state.
- Rotation triggers when `maxEvents` (500), `maxMs` (60,000), or `maxBytes` (262,144) is reached.
- `ISegmentSink.write(segment, { index, sealed, final })` must be idempotent per `(bundle.id, index)`. Open segments (`sealed: false`) may be overwritten; sealed segments (`sealed: true`) are immutable.

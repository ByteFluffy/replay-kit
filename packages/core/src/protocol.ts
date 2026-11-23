/**
 * Replay protocol v1.
 *
 * The core knows nothing about what a channel's `data` means. Hosts declare a
 * `format` per channel and register an adapter that understands it.
 */

export type ReplaySeverity = 'warn' | 'error';

export type ReplayPlaybackPolicy = {
  /** Gaps longer than this are compressed when idle-skipping is on. Default 1800. */
  readonly maxIdleGapMs?: number;
  /** Length a compressed gap is squeezed to. Default 900. */
  readonly compressedGapMs?: number;
  /** Default playback speed multiplier (> 0). Default 1. */
  readonly speed?: number;
};

/** Present on bundles that are one piece of a longer recorded session. */
export type ReplaySegmentInfo = {
  readonly index: number;
  /** Global seq of this segment's first event. */
  readonly baseSeq: number;
  /** True on the last segment of a finished session. */
  readonly final?: boolean;
};

export type ReplayChannelDecl = {
  /** e.g. `"yjs@1"`, `"my-host.agent@1"`. Matched exactly by adapters. */
  readonly format: string;
};

export type ReplayEvent = {
  /** Milliseconds since session start. Non-decreasing across the stream. */
  readonly t: number;
  readonly ch: string;
  /** Informational kind; the engine never branches on it. */
  readonly k?: string;
  /** Channel-private payload; must be JSON-serializable. */
  readonly data?: unknown;
  /** Semantic step point for step-forward / step-back. */
  readonly step?: true;
  /** Causal correlation key shared across channels. */
  readonly corr?: string;
  readonly sev?: ReplaySeverity;
  /** Only needed on events that must be addressable via `seek({ eventId })`. */
  readonly id?: string;
};

export type ReplayKeyframe = {
  /** State after applying events[0..seq] (inclusive). */
  readonly seq: number;
  /**
   * Per-channel snapshots. Use `null` for stateless channels. A channel that is
   * missing here is rebuilt by replaying its events from the start.
   */
  readonly state: Readonly<Record<string, unknown>>;
};

export type ReplayBundle = {
  readonly v: 1;
  readonly id: string;
  readonly host: string;
  readonly title?: string;
  readonly channels: Readonly<Record<string, ReplayChannelDecl>>;
  /** Event time (`t`) at which the timeline starts. Default 0. */
  readonly originMs?: number;
  readonly segment?: ReplaySegmentInfo;
  readonly playback?: ReplayPlaybackPolicy;
  /** Host-defined, opaque to the engine. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Per-channel state before events[0]. */
  readonly initialState: Readonly<Record<string, unknown>>;
  /** Appears after joining segments; keyframe seq is 0-based within `events`. */
  readonly keyframes?: readonly ReplayKeyframe[];
  /** Events across all channels; `seq` is the array index. */
  readonly events: readonly ReplayEvent[];
};

export const DEFAULT_MAX_IDLE_GAP_MS = 1800;
export const DEFAULT_COMPRESSED_GAP_MS = 900;
export const DEFAULT_SPEED = 1;

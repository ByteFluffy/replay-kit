import type { ReplayEvent } from './protocol.ts';

export type ReplayAdapterContext = {
  resolveAssetUrl(assetId: string): Promise<string | undefined>;
};

/**
 * Host-implemented bridge between one channel's events and the host's real
 * state / UI. The engine never interprets `event.data`.
 */
export interface IReplayChannel<TSnapshot = unknown> {
  readonly channel: string;
  /** If set, the bundle's declared format for this channel must be in the list. */
  readonly formats?: readonly string[];
  /** Go back to the state before the first event. */
  reset(initial: TSnapshot | undefined, ctx: ReplayAdapterContext): void;
  /**
   * Jump to a keyframe snapshot. Optional: without it the engine rebuilds the
   * channel with `reset` + replaying its events (always correct, slower).
   */
  restore?(snapshot: TSnapshot, ctx: ReplayAdapterContext): void;
  apply(event: ReplayEvent, ctx: ReplayAdapterContext): void;
  /** Optional fast path: apply consecutive events of this channel at once. */
  applyBatch?(events: readonly ReplayEvent[], ctx: ReplayAdapterContext): void;
  /** Called around large jumps so heavy work (e.g. media decoding) can be deferred. */
  onSeekPhase?(phase: 'start' | 'end'): void;
  /** Used by the recorder to take segment baselines; return `null` for stateless channels. */
  capture?(): TSnapshot | null;
  dispose?(): void;
}

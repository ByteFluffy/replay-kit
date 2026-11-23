export type TimeWarpOptions = {
  readonly enabled: boolean;
  readonly maxIdleGapMs: number;
  readonly compressedGapMs: number;
};

export type IdleGap = {
  readonly rawGapMs: number;
  readonly rawStartMs: number;
  readonly rawEndMs: number;
};

type Piece = {
  rawStart: number;
  rawEnd: number;
  warpStart: number;
  warpEnd: number;
  idle: boolean;
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Piecewise-linear map between raw recorded time and playback ("warped") time,
 * where long idle gaps between events are squeezed. Times are relative to the
 * timeline origin. Pure function of the event times.
 */
export class TimeWarp {
  readonly totalWarpedMs: number;
  readonly rawDurationMs: number;
  readonly #pieces: readonly Piece[];

  private constructor(pieces: readonly Piece[], totalWarpedMs: number, rawDurationMs: number) {
    this.#pieces = pieces;
    this.totalWarpedMs = totalWarpedMs;
    this.rawDurationMs = rawDurationMs;
  }

  /** @param times event times relative to the origin, non-decreasing. */
  static build(times: readonly number[], opts: TimeWarpOptions): TimeWarp {
    const pieces: Piece[] = [];
    let prev = 0;
    let warp = 0;
    for (const t of times) {
      const gap = t - prev;
      if (gap <= 0) {
        prev = Math.max(prev, t);
        continue;
      }
      const idle = opts.enabled && gap > opts.maxIdleGapMs;
      const len = idle ? Math.min(gap, opts.compressedGapMs) : gap;
      const last = pieces[pieces.length - 1];
      if (!idle && last && !last.idle) {
        last.rawEnd = t;
        last.warpEnd += len;
      } else {
        pieces.push({ rawStart: prev, rawEnd: t, warpStart: warp, warpEnd: warp + len, idle });
      }
      warp += len;
      prev = t;
    }
    return new TimeWarp(pieces, warp, prev);
  }

  rawToWarped(raw: number): number {
    const p = this.#pieceByRaw(clamp(raw, 0, this.rawDurationMs));
    if (!p) return 0;
    const r = clamp(raw, 0, this.rawDurationMs);
    return p.warpStart + ((r - p.rawStart) / (p.rawEnd - p.rawStart)) * (p.warpEnd - p.warpStart);
  }

  warpedToRaw(warped: number): number {
    const w = clamp(warped, 0, this.totalWarpedMs);
    const pieces = this.#pieces;
    if (pieces.length === 0) return 0;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid]!.warpStart <= w) lo = mid;
      else hi = mid - 1;
    }
    const p = pieces[lo]!;
    const span = p.warpEnd - p.warpStart;
    if (span <= 0) return p.rawEnd;
    return p.rawStart + ((w - p.warpStart) / span) * (p.rawEnd - p.rawStart);
  }

  /** The compressed gap that `raw` is strictly inside of, if any. */
  idleGapAt(raw: number): IdleGap | null {
    const r = clamp(raw, 0, this.rawDurationMs);
    const p = this.#pieceByRaw(r);
    if (!p || !p.idle || r <= p.rawStart || r >= p.rawEnd) return null;
    return { rawGapMs: p.rawEnd - p.rawStart, rawStartMs: p.rawStart, rawEndMs: p.rawEnd };
  }

  #pieceByRaw(r: number): Piece | undefined {
    const pieces = this.#pieces;
    if (pieces.length === 0) return undefined;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid]!.rawStart <= r) lo = mid;
      else hi = mid - 1;
    }
    return pieces[lo];
  }
}

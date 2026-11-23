import type { IReplayChannel, ReplayAdapterContext } from './channel.ts';
import {
  buildStepIndex,
  findKeyframeIndex,
  lastSeqAtOrBefore,
  stepIndexAtOrBefore,
} from './index-utils.ts';
import {
  DEFAULT_COMPRESSED_GAP_MS,
  DEFAULT_MAX_IDLE_GAP_MS,
  DEFAULT_SPEED,
  type ReplayBundle,
  type ReplayEvent,
} from './protocol.ts';
import { TimeWarp } from './time-warp.ts';
import { parseBundle } from './validate.ts';

export type ReplayStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export type ReplaySnapshot = {
  readonly status: ReplayStatus;
  readonly bundleId: string | null;
  readonly host: string | null;
  readonly title: string | null;
  readonly currentSeq: number;
  readonly totalEvents: number;
  readonly currentTimeMs: number;
  readonly totalDurationMs: number;
  readonly rawTimeMs: number;
  readonly rawDurationMs: number;
  readonly currentStepIndex: number;
  readonly totalSteps: number;
  readonly speed: number;
  readonly skipIdle: boolean;
  readonly activeIdleGap: { readonly rawGapMs: number } | null;
  readonly activeCorr: string | null;
  readonly error: string | null;
};

export type ReplaySeekTarget =
  | { readonly time: number }
  | { readonly seq: number }
  | { readonly eventId: string }
  | { readonly step: number }
  | { readonly edge: 'start' | 'end' };

export interface IReplayScheduler {
  now(): number;
  requestFrame(cb: (nowMs: number) => void): number;
  cancelFrame(handle: number): void;
}

export type ReplayControllerOptions = {
  readonly resolveAssetUrl?: (assetId: string) => Promise<string | undefined>;
  readonly scheduler?: IReplayScheduler;
  readonly skipIdle?: boolean;
};

const MAX_FRAME_DT_MS = 250;

type GlobalTimers = {
  performance?: { now(): number };
  requestAnimationFrame?: (cb: (ts: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  setTimeout?: (cb: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
};

function createDefaultScheduler(): IReplayScheduler {
  const g = globalThis as unknown as GlobalTimers;
  const now = (): number => (g.performance ? g.performance.now() : Date.now());
  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    const raf = g.requestAnimationFrame.bind(globalThis);
    const caf = g.cancelAnimationFrame.bind(globalThis);
    return {
      now,
      requestFrame: (cb) => raf(() => cb(now())),
      cancelFrame: (handle) => caf(handle),
    };
  }
  const setT = g.setTimeout!.bind(globalThis);
  const clrT = g.clearTimeout!.bind(globalThis);
  return {
    now,
    requestFrame: (cb) => setT(() => cb(now()), 16),
    cancelFrame: (handle) => clrT(handle),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function hasOwn(obj: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReplayController {
  readonly #adapters = new Map<string, IReplayChannel>();
  readonly #listeners = new Set<() => void>();
  readonly #scheduler: IReplayScheduler;
  readonly #ctx: ReplayAdapterContext;

  #bundle: ReplayBundle | null = null;
  #relTimes: number[] = [];
  #stepSeqs: number[] = [];
  #eventIdToSeq = new Map<string, number>();
  #timeWarp: TimeWarp = TimeWarp.build([], {
    enabled: true,
    maxIdleGapMs: DEFAULT_MAX_IDLE_GAP_MS,
    compressedGapMs: DEFAULT_COMPRESSED_GAP_MS,
  });

  #status: ReplayStatus = 'idle';
  #currentSeq = -1;
  #rawPos = 0;
  #warpedPos = 0;
  #speed = DEFAULT_SPEED;
  #skipIdle: boolean;
  #error: string | null = null;

  #frameHandle: number | null = null;
  #lastFrameMs = 0;
  #disposed = false;
  #snapshot: ReplaySnapshot;

  constructor(options?: ReplayControllerOptions) {
    this.#scheduler = options?.scheduler ?? createDefaultScheduler();
    this.#skipIdle = options?.skipIdle ?? true;
    const resolveAssetUrl = options?.resolveAssetUrl ?? (async () => undefined);
    this.#ctx = { resolveAssetUrl };
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): ReplaySnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  registerChannel(adapter: IReplayChannel): () => void {
    if (this.#disposed) throw new Error('ReplayController is disposed');
    if (this.#adapters.has(adapter.channel)) {
      throw new Error(`Channel "${adapter.channel}" is already registered`);
    }
    this.#adapters.set(adapter.channel, adapter);

    if (this.#bundle && this.#status !== 'error' && this.#status !== 'idle') {
      const decl = this.#bundle.channels[adapter.channel];
      if (decl && adapter.formats && !adapter.formats.includes(decl.format)) {
        this.#stopLoop();
        this.#status = 'error';
        this.#error = `Channel "${adapter.channel}" format mismatch: expected [${adapter.formats.join(', ')}], got "${decl.format}"`;
        this.#commit();
      } else {
        this.#syncSingleAdapter(adapter, this.#currentSeq);
      }
    }

    return () => {
      if (this.#adapters.get(adapter.channel) === adapter) {
        this.#adapters.delete(adapter.channel);
      }
    };
  }

  load(input: unknown): void {
    if (this.#disposed) return;
    this.#stopLoop();
    this.#status = 'loading';
    this.#error = null;

    let bundle: ReplayBundle;
    try {
      bundle = parseBundle(input);
    } catch (err) {
      this.#clearLoaded();
      this.#status = 'error';
      this.#error = errorMessage(err);
      this.#commit();
      return;
    }

    for (const [ch, adapter] of this.#adapters) {
      const decl = bundle.channels[ch];
      if (decl && adapter.formats && !adapter.formats.includes(decl.format)) {
        this.#clearLoaded();
        this.#status = 'error';
        this.#error = `Channel "${ch}" format mismatch: expected [${adapter.formats.join(', ')}], got "${decl.format}"`;
        this.#commit();
        return;
      }
    }

    const origin = bundle.originMs ?? 0;
    const relTimes = new Array<number>(bundle.events.length);
    const idMap = new Map<string, number>();
    for (let i = 0; i < bundle.events.length; i++) {
      const ev = bundle.events[i]!;
      relTimes[i] = ev.t - origin;
      if (ev.id !== undefined) idMap.set(ev.id, i);
    }

    this.#bundle = bundle;
    this.#relTimes = relTimes;
    this.#stepSeqs = buildStepIndex(bundle.events);
    this.#eventIdToSeq = idMap;
    this.#speed = bundle.playback?.speed ?? DEFAULT_SPEED;
    this.#timeWarp = this.#buildTimeWarp(bundle, relTimes);
    this.#currentSeq = -1;
    this.#rawPos = 0;
    this.#warpedPos = 0;

    for (const [ch, adapter] of this.#adapters) {
      try {
        adapter.reset(bundle.initialState[ch], this.#ctx);
      } catch (err) {
        this.#status = 'error';
        this.#error = `[${ch}] ${errorMessage(err)}`;
        this.#commit();
        return;
      }
    }

    this.#status = 'ready';
    this.#commit();
  }

  play(): void {
    if (this.#disposed || !this.#bundle) return;
    if (this.#status !== 'ready' && this.#status !== 'paused' && this.#status !== 'ended') return;

    const total = this.#bundle.events.length;
    if (total === 0) {
      this.#status = 'ended';
      this.#commit();
      return;
    }

    if (this.#status === 'ended') {
      if (!this.#goToSeq(-1)) return;
      this.#rawPos = 0;
      this.#warpedPos = 0;
    }

    const dueSeq = lastSeqAtOrBefore(this.#relTimes, this.#rawPos);
    if (dueSeq > this.#currentSeq) {
      if (!this.#applyRange(this.#currentSeq + 1, dueSeq)) return;
      this.#currentSeq = dueSeq;
    }

    if (this.#currentSeq >= total - 1 && this.#warpedPos >= this.#timeWarp.totalWarpedMs) {
      this.#status = 'ended';
      this.#commit();
      return;
    }

    this.#status = 'playing';
    this.#commit();
    this.#startLoop();
  }

  pause(): void {
    if (this.#disposed || this.#status !== 'playing') return;
    this.#stopLoop();
    this.#status = 'paused';
    this.#commit();
  }

  seek(target: ReplaySeekTarget): boolean {
    if (this.#disposed || !this.#bundle) return false;
    if (this.#status === 'idle' || this.#status === 'loading' || this.#status === 'error') return false;

    const total = this.#bundle.events.length;
    const last = total - 1;
    let targetSeq: number;
    let targetRaw: number;

    if ('seq' in target) {
      targetSeq = clamp(Math.trunc(target.seq), -1, last);
      targetRaw = targetSeq >= 0 ? this.#relTimes[targetSeq]! : 0;
    } else if ('time' in target) {
      const w = clamp(target.time, 0, this.#timeWarp.totalWarpedMs);
      targetRaw = this.#timeWarp.warpedToRaw(w);
      targetSeq = w >= this.#timeWarp.totalWarpedMs && total > 0 ? last : lastSeqAtOrBefore(this.#relTimes, targetRaw);
    } else if ('eventId' in target) {
      const found = this.#eventIdToSeq.get(target.eventId);
      if (found === undefined) return false;
      targetSeq = found;
      targetRaw = this.#relTimes[targetSeq]!;
    } else if ('step' in target) {
      if (this.#stepSeqs.length === 0) return false;
      const idx = clamp(Math.trunc(target.step), 0, this.#stepSeqs.length - 1);
      targetSeq = this.#stepSeqs[idx]!;
      targetRaw = this.#relTimes[targetSeq]!;
    } else {
      if (target.edge === 'start') {
        targetSeq = -1;
        targetRaw = 0;
      } else {
        targetSeq = last;
        targetRaw = total > 0 ? this.#relTimes[last]! : 0;
      }
    }

    if (!this.#goToSeq(targetSeq)) return false;

    this.#rawPos = targetRaw;
    this.#warpedPos = this.#timeWarp.rawToWarped(targetRaw);

    if (this.#status === 'playing') {
      if (total > 0 && targetSeq === last && this.#warpedPos >= this.#timeWarp.totalWarpedMs) {
        this.#stopLoop();
        this.#status = 'ended';
      } else {
        this.#lastFrameMs = this.#scheduler.now();
      }
    } else if (total > 0 && targetSeq === last && this.#warpedPos >= this.#timeWarp.totalWarpedMs) {
      this.#status = 'ended';
    } else if (targetSeq === -1 && targetRaw === 0 && this.#status === 'ready') {
      this.#status = 'ready';
    } else {
      this.#status = 'paused';
    }

    this.#commit();
    return true;
  }

  step(dir: 1 | -1): boolean {
    if (this.#disposed || !this.#bundle) return false;
    if (this.#status === 'idle' || this.#status === 'loading' || this.#status === 'error') return false;
    const total = this.#bundle.events.length;

    if (dir === 1) {
      for (const s of this.#stepSeqs) {
        if (s > this.#currentSeq) return this.seek({ seq: s });
      }
      if (this.#currentSeq < total - 1) return this.seek({ edge: 'end' });
      return false;
    }

    for (let i = this.#stepSeqs.length - 1; i >= 0; i--) {
      const s = this.#stepSeqs[i]!;
      if (s < this.#currentSeq) return this.seek({ seq: s });
    }
    if (this.#currentSeq >= 0) return this.seek({ edge: 'start' });
    return false;
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError('speed must be a finite number > 0');
    }
    if (speed === this.#speed) return;
    this.#speed = speed;
    this.#commit();
  }

  setSkipIdle(enabled: boolean): void {
    if (enabled === this.#skipIdle) return;
    this.#skipIdle = enabled;
    if (this.#bundle) {
      this.#timeWarp = this.#buildTimeWarp(this.#bundle, this.#relTimes);
      this.#warpedPos = this.#timeWarp.rawToWarped(this.#rawPos);
    }
    this.#commit();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopLoop();
    for (const adapter of this.#adapters.values()) {
      adapter.dispose?.();
    }
    this.#adapters.clear();
    this.#listeners.clear();
    this.#clearLoaded();
  }

  #buildTimeWarp(bundle: ReplayBundle, relTimes: readonly number[]): TimeWarp {
    return TimeWarp.build(relTimes, {
      enabled: this.#skipIdle,
      maxIdleGapMs: bundle.playback?.maxIdleGapMs ?? DEFAULT_MAX_IDLE_GAP_MS,
      compressedGapMs: bundle.playback?.compressedGapMs ?? DEFAULT_COMPRESSED_GAP_MS,
    });
  }

  #clearLoaded(): void {
    this.#bundle = null;
    this.#relTimes = [];
    this.#stepSeqs = [];
    this.#eventIdToSeq.clear();
    this.#timeWarp = TimeWarp.build([], {
      enabled: this.#skipIdle,
      maxIdleGapMs: DEFAULT_MAX_IDLE_GAP_MS,
      compressedGapMs: DEFAULT_COMPRESSED_GAP_MS,
    });
    this.#currentSeq = -1;
    this.#rawPos = 0;
    this.#warpedPos = 0;
  }

  #startLoop(): void {
    this.#stopLoop();
    this.#lastFrameMs = this.#scheduler.now();
    this.#frameHandle = this.#scheduler.requestFrame((nowMs) => this.#onFrame(nowMs));
  }

  #stopLoop(): void {
    if (this.#frameHandle !== null) {
      this.#scheduler.cancelFrame(this.#frameHandle);
      this.#frameHandle = null;
    }
  }

  #onFrame(nowMs: number): void {
    this.#frameHandle = null;
    if (this.#disposed || this.#status !== 'playing' || !this.#bundle) return;

    const dt = Math.min(Math.max(0, nowMs - this.#lastFrameMs), MAX_FRAME_DT_MS) * this.#speed;
    this.#lastFrameMs = nowMs;

    const totalWarped = this.#timeWarp.totalWarpedMs;
    const nextWarped = Math.min(this.#warpedPos + dt, totalWarped);
    const nextRaw = this.#timeWarp.warpedToRaw(nextWarped);
    const total = this.#bundle.events.length;
    const targetSeq = nextWarped >= totalWarped && total > 0
      ? total - 1
      : lastSeqAtOrBefore(this.#relTimes, nextRaw);

    if (targetSeq > this.#currentSeq) {
      if (!this.#applyRange(this.#currentSeq + 1, targetSeq)) return;
      this.#currentSeq = targetSeq;
    }

    this.#warpedPos = nextWarped;
    this.#rawPos = nextRaw;

    if (this.#currentSeq >= total - 1 && this.#warpedPos >= totalWarped) {
      this.#status = 'ended';
      this.#commit();
      return;
    }

    this.#commit();
    this.#frameHandle = this.#scheduler.requestFrame((ts) => this.#onFrame(ts));
  }

  #goToSeq(targetSeq: number): boolean {
    const bundle = this.#bundle;
    if (!bundle) return false;
    if (targetSeq === this.#currentSeq) return true;

    const keyframes = bundle.keyframes ?? [];
    const kfIdx = targetSeq >= 0 ? findKeyframeIndex(keyframes, targetSeq) : -1;
    const kf = kfIdx >= 0 ? keyframes[kfIdx] : undefined;

    if (targetSeq > this.#currentSeq && (!kf || kf.seq <= this.#currentSeq)) {
      if (!this.#applyRange(this.#currentSeq + 1, targetSeq)) return false;
      this.#currentSeq = targetSeq;
      return true;
    }

    const baseSeq = kf ? kf.seq : -1;
    this.#notifySeekPhase('start');
    try {
      for (const [ch, adapter] of this.#adapters) {
        if (!this.#restoreChannel(ch, adapter, bundle, kf, baseSeq)) return false;
      }
      if (baseSeq < targetSeq) {
        if (!this.#applyRange(baseSeq + 1, targetSeq)) return false;
      }
      this.#currentSeq = targetSeq;
      return true;
    } finally {
      this.#notifySeekPhase('end');
    }
  }

  #syncSingleAdapter(adapter: IReplayChannel, targetSeq: number): void {
    const bundle = this.#bundle;
    if (!bundle) return;
    const keyframes = bundle.keyframes ?? [];
    const kfIdx = targetSeq >= 0 ? findKeyframeIndex(keyframes, targetSeq) : -1;
    const kf = kfIdx >= 0 ? keyframes[kfIdx] : undefined;
    const baseSeq = kf ? kf.seq : -1;

    if (!this.#restoreChannel(adapter.channel, adapter, bundle, kf, baseSeq)) return;
    if (baseSeq < targetSeq) {
      this.#applyChannelRange(adapter, bundle.events, baseSeq + 1, targetSeq);
    }
  }

  #restoreChannel(
    ch: string,
    adapter: IReplayChannel,
    bundle: ReplayBundle,
    kf: { readonly seq: number; readonly state: Readonly<Record<string, unknown>> } | undefined,
    baseSeq: number,
  ): boolean {
    try {
      if (kf && adapter.restore && hasOwn(kf.state, ch)) {
        adapter.restore(kf.state[ch], this.#ctx);
        return true;
      }
      adapter.reset(bundle.initialState[ch], this.#ctx);
      if (baseSeq >= 0) {
        return this.#applyChannelRange(adapter, bundle.events, 0, baseSeq);
      }
      return true;
    } catch (err) {
      this.#failAdapter(ch, err);
      return false;
    }
  }

  #applyChannelRange(
    adapter: IReplayChannel,
    events: readonly ReplayEvent[],
    fromSeq: number,
    toSeq: number,
  ): boolean {
    const batch: ReplayEvent[] = [];
    for (let i = fromSeq; i <= toSeq; i++) {
      const ev = events[i]!;
      if (ev.ch === adapter.channel) batch.push(ev);
    }
    if (batch.length === 0) return true;
    try {
      if (batch.length > 1 && adapter.applyBatch) {
        adapter.applyBatch(batch, this.#ctx);
      } else {
        for (const ev of batch) adapter.apply(ev, this.#ctx);
      }
      return true;
    } catch (err) {
      this.#failAdapter(adapter.channel, err);
      return false;
    }
  }

  #applyRange(fromSeq: number, toSeq: number): boolean {
    const bundle = this.#bundle;
    if (!bundle || fromSeq > toSeq) return true;
    const events = bundle.events;
    let i = fromSeq;
    while (i <= toSeq) {
      const first = events[i]!;
      let j = i + 1;
      while (j <= toSeq && events[j]!.ch === first.ch) j++;
      const adapter = this.#adapters.get(first.ch);
      if (adapter) {
        try {
          if (j - i > 1 && adapter.applyBatch) {
            adapter.applyBatch(events.slice(i, j), this.#ctx);
          } else {
            for (let k = i; k < j; k++) adapter.apply(events[k]!, this.#ctx);
          }
        } catch (err) {
          this.#failAdapter(first.ch, err);
          return false;
        }
      }
      i = j;
    }
    return true;
  }

  #notifySeekPhase(phase: 'start' | 'end'): void {
    for (const adapter of this.#adapters.values()) {
      adapter.onSeekPhase?.(phase);
    }
  }

  #failAdapter(channel: string, err: unknown): void {
    this.#stopLoop();
    this.#status = 'error';
    this.#error = `[${channel}] ${errorMessage(err)}`;
    this.#commit();
  }

  #buildSnapshot(): ReplaySnapshot {
    const bundle = this.#bundle;
    const gap = this.#timeWarp.idleGapAt(this.#rawPos);
    const activeEvent = bundle && this.#currentSeq >= 0 ? bundle.events[this.#currentSeq] : undefined;
    return {
      status: this.#status,
      bundleId: bundle ? bundle.id : null,
      host: bundle ? bundle.host : null,
      title: bundle?.title ?? null,
      currentSeq: this.#currentSeq,
      totalEvents: bundle ? bundle.events.length : 0,
      currentTimeMs: this.#warpedPos,
      totalDurationMs: this.#timeWarp.totalWarpedMs,
      rawTimeMs: this.#rawPos,
      rawDurationMs: this.#timeWarp.rawDurationMs,
      currentStepIndex: this.#currentSeq >= 0 ? stepIndexAtOrBefore(this.#stepSeqs, this.#currentSeq) : -1,
      totalSteps: this.#stepSeqs.length,
      speed: this.#speed,
      skipIdle: this.#skipIdle,
      activeIdleGap: gap ? { rawGapMs: gap.rawGapMs } : null,
      activeCorr: activeEvent?.corr ?? null,
      error: this.#error,
    };
  }

  #commit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

import { joinSegments } from './join.ts';
import type {
  ReplayBundle,
  ReplayChannelDecl,
  ReplayEvent,
  ReplayPlaybackPolicy,
  ReplaySeverity,
} from './protocol.ts';

export type SegmentWriteInfo = {
  readonly index: number;
  readonly sealed: boolean;
  readonly final: boolean;
};

export interface ISegmentSink {
  write(segment: ReplayBundle, info: SegmentWriteInfo): void | Promise<void>;
}

export type ReplaySegmentPolicy = {
  readonly maxEvents?: number;
  readonly maxMs?: number;
  readonly maxBytes?: number;
};

export type RecordEventInput = {
  readonly ch: string;
  readonly k?: string;
  readonly data?: unknown;
  readonly step?: true;
  readonly corr?: string;
  readonly sev?: ReplaySeverity;
  readonly id?: string;
  /** Optional explicit timestamp (clamped to be monotonic). */
  readonly t?: number;
  /** Clone `data` to insulate from later host mutations. Default true. */
  readonly clone?: boolean;
};

export type ReplayRecorderOptions = {
  readonly id: string;
  readonly host: string;
  readonly title?: string;
  readonly channels: Readonly<Record<string, ReplayChannelDecl>>;
  readonly captures?: Readonly<Record<string, () => unknown>>;
  readonly sink?: ISegmentSink;
  readonly segment?: ReplaySegmentPolicy | false;
  readonly playback?: ReplayPlaybackPolicy;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly maxSessionBytes?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown, info: SegmentWriteInfo) => void;
};

type QueuedSegment = {
  readonly bundle: ReplayBundle;
  readonly info: SegmentWriteInfo;
};

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_MS = 60_000;
const DEFAULT_MAX_BYTES = 262_144;

function defaultNow(): number {
  const g = globalThis as unknown as { performance?: { now(): number } };
  return g.performance ? g.performance.now() : Date.now();
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  const g = globalThis as unknown as { structuredClone?: <U>(v: U) => U };
  if (typeof g.structuredClone === 'function') return g.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function buildSegmentEvent(input: RecordEventInput, t: number): ReplayEvent {
  const data = input.data === undefined ? undefined : (input.clone === false ? input.data : cloneValue(input.data));
  return {
    t,
    ch: input.ch,
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(input.step === true ? { step: true } : {}),
    ...(input.corr !== undefined ? { corr: input.corr } : {}),
    ...(input.sev !== undefined ? { sev: input.sev } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
  };
}

export class ReplayRecorder {
  readonly #opts: ReplayRecorderOptions;
  readonly #now: () => number;
  readonly #segmentPolicy: Required<ReplaySegmentPolicy> | null;

  #started = false;
  #stopped = false;
  #limitReached = false;
  #startWallMs = 0;
  #lastT = 0;
  #globalSeq = 0;
  #totalBytes = 0;

  #segIndex = 0;
  #segBaseSeq = 0;
  #segOriginMs = 0;
  #segInitialState: Record<string, unknown> = {};
  #segEvents: ReplayEvent[] = [];
  #segBytes = 0;

  readonly #memorySegments: ReplayBundle[] = [];
  readonly #pendingQueue: QueuedSegment[] = [];
  #draining: Promise<void> | null = null;

  constructor(options: ReplayRecorderOptions) {
    this.#opts = options;
    this.#now = options.now ?? defaultNow;
    if (options.segment === false) {
      this.#segmentPolicy = null;
    } else {
      this.#segmentPolicy = {
        maxEvents: options.segment?.maxEvents ?? DEFAULT_MAX_EVENTS,
        maxMs: options.segment?.maxMs ?? DEFAULT_MAX_MS,
        maxBytes: options.segment?.maxBytes ?? DEFAULT_MAX_BYTES,
      };
    }
  }

  get started(): boolean {
    return this.#started;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get pendingCount(): number {
    return this.#pendingQueue.length;
  }

  start(initialState?: Readonly<Record<string, unknown>>): void {
    if (this.#started) throw new Error('ReplayRecorder already started');
    if (this.#segmentPolicy) {
      for (const ch of Object.keys(this.#opts.channels)) {
        if (typeof this.#opts.captures?.[ch] !== 'function') {
          throw new Error(`Missing capture() function for channel "${ch}" required by segmentation`);
        }
      }
    }

    this.#started = true;
    this.#startWallMs = this.#now();
    this.#lastT = 0;
    this.#segIndex = 0;
    this.#segBaseSeq = 0;
    this.#segOriginMs = 0;
    this.#segInitialState = initialState ? cloneValue({ ...initialState }) : this.#captureAll();
    this.#segEvents = [];
    this.#segBytes = 0;
  }

  /**
   * Records one event after the host has applied its state change.
   * Returns the assigned global seq, or -1 if stopped or session byte limit reached.
   */
  record(input: RecordEventInput): number {
    if (!this.#started) throw new Error('ReplayRecorder has not been started');
    if (this.#stopped) return -1;
    if (!Object.prototype.hasOwnProperty.call(this.#opts.channels, input.ch)) {
      throw new Error(`Undeclared channel "${input.ch}"`);
    }
    if (this.#limitReached) return -1;

    const rawT = input.t !== undefined ? Math.round(input.t) : Math.round(this.#now() - this.#startWallMs);
    const t = Math.max(this.#lastT, Number.isFinite(rawT) ? rawT : this.#lastT);
    const ev = buildSegmentEvent(input, t);
    const evBytes = utf8ByteLength(JSON.stringify(ev)) + 1;

    if (
      this.#opts.maxSessionBytes !== undefined &&
      this.#totalBytes + evBytes > this.#opts.maxSessionBytes
    ) {
      this.#limitReached = true;
      if (Object.prototype.hasOwnProperty.call(this.#opts.channels, 'diag')) {
        const limitEv: ReplayEvent = {
          t,
          ch: 'diag',
          k: 'record.limit',
          sev: 'warn',
          data: { maxSessionBytes: this.#opts.maxSessionBytes, totalBytes: this.#totalBytes },
        };
        this.#pushEvent(limitEv, utf8ByteLength(JSON.stringify(limitEv)) + 1);
      }
      return -1;
    }

    const seq = this.#pushEvent(ev, evBytes);
    this.#maybeRotate();
    return seq;
  }

  async flush(options?: { readonly includeOpen?: boolean }): Promise<void> {
    if (!this.#started || !this.#opts.sink) return;
    await this.#drain();
    if (options?.includeOpen && !this.#stopped && this.#pendingQueue.length === 0 && this.#segEvents.length > 0) {
      const info: SegmentWriteInfo = { index: this.#segIndex, sealed: false, final: false };
      const bundle = this.#buildOpenBundle(false);
      try {
        await this.#opts.sink.write(bundle, info);
      } catch (err) {
        this.#opts.onError?.(err, info);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started || this.#stopped) return;
    this.#stopped = true;
    this.#sealCurrent(true);
    await this.#drain();
  }

  compile(): ReplayBundle {
    if (!this.#started) throw new Error('ReplayRecorder has not been started');
    const segments = [...this.#memorySegments];
    if (!this.#stopped && (this.#segEvents.length > 0 || segments.length === 0)) {
      segments.push(this.#buildOpenBundle(false));
    }
    return joinSegments(segments);
  }

  #pushEvent(ev: ReplayEvent, evBytes: number): number {
    const seq = this.#globalSeq++;
    this.#lastT = ev.t;
    this.#segEvents.push(ev);
    this.#segBytes += evBytes;
    this.#totalBytes += evBytes;
    return seq;
  }

  #maybeRotate(): void {
    const policy = this.#segmentPolicy;
    if (!policy) return;
    const elapsed = this.#lastT - this.#segOriginMs;
    if (
      this.#segEvents.length >= policy.maxEvents ||
      elapsed >= policy.maxMs ||
      this.#segBytes >= policy.maxBytes
    ) {
      this.#sealCurrent(false);
      this.#segIndex += 1;
      this.#segBaseSeq = this.#globalSeq;
      this.#segOriginMs = this.#lastT;
      this.#segInitialState = this.#captureAll();
      this.#segEvents = [];
      this.#segBytes = 0;
      void this.#drain();
    }
  }

  #sealCurrent(final: boolean): void {
    const bundle = this.#buildOpenBundle(final);
    this.#memorySegments.push(bundle);
    if (this.#opts.sink) {
      this.#pendingQueue.push({
        bundle,
        info: { index: this.#segIndex, sealed: true, final },
      });
    }
  }

  #buildOpenBundle(final: boolean): ReplayBundle {
    const segInfo = this.#segmentPolicy || this.#segIndex > 0 || final
      ? {
          index: this.#segIndex,
          baseSeq: this.#segBaseSeq,
          ...(final ? { final: true } : {}),
        }
      : undefined;

    return {
      v: 1,
      id: this.#opts.id,
      host: this.#opts.host,
      ...(this.#opts.title !== undefined ? { title: this.#opts.title } : {}),
      channels: this.#opts.channels,
      originMs: this.#segOriginMs,
      ...(segInfo ? { segment: segInfo } : {}),
      ...(this.#opts.playback !== undefined ? { playback: this.#opts.playback } : {}),
      ...(this.#opts.meta !== undefined ? { meta: this.#opts.meta } : {}),
      initialState: this.#segInitialState,
      events: [...this.#segEvents],
    };
  }

  #captureAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const ch of Object.keys(this.#opts.channels)) {
      const fn = this.#opts.captures?.[ch];
      out[ch] = fn ? cloneValue(fn()) : null;
    }
    return out;
  }

  #drain(): Promise<void> {
    if (!this.#opts.sink) return Promise.resolve();
    if (this.#draining) return this.#draining;
    const sink = this.#opts.sink;
    const task = (async () => {
      while (this.#pendingQueue.length > 0) {
        const next = this.#pendingQueue[0]!;
        try {
          await sink.write(next.bundle, next.info);
          this.#pendingQueue.shift();
        } catch (err) {
          this.#opts.onError?.(err, next.info);
          break;
        }
      }
    })();
    this.#draining = task.finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }
}

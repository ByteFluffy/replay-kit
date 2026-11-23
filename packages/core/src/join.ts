import type { ReplayBundle, ReplayChannelDecl, ReplayEvent, ReplayKeyframe } from './protocol.ts';
import { parseBundle, ReplayValidationError } from './validate.ts';

/**
 * Concatenates ordered session segments into a single playable bundle.
 * Each subsequent segment's `initialState` becomes a keyframe at `baseSeq - 1`.
 */
export function joinSegments(segments: readonly ReplayBundle[]): ReplayBundle {
  if (segments.length === 0) {
    throw new ReplayValidationError([{ path: '', message: 'cannot join empty segment list' }]);
  }

  const parsed = segments.map((s) => parseBundle(s));

  if (parsed.length === 1 && !parsed[0]!.segment) {
    const single = parsed[0]!;
    return {
      v: single.v,
      id: single.id,
      host: single.host,
      ...(single.title !== undefined ? { title: single.title } : {}),
      channels: single.channels,
      ...(single.originMs !== undefined ? { originMs: single.originMs } : {}),
      ...(single.playback !== undefined ? { playback: single.playback } : {}),
      ...(single.meta !== undefined ? { meta: single.meta } : {}),
      initialState: single.initialState,
      ...(single.keyframes !== undefined ? { keyframes: single.keyframes } : {}),
      events: single.events,
    };
  }

  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i]!.segment) {
      throw new ReplayValidationError([{ path: `segments[${i}].segment`, message: 'missing segment metadata' }]);
    }
  }

  const sorted = [...parsed].sort((a, b) => a.segment!.index - b.segment!.index);
  const first = sorted[0]!;
  const channels: Record<string, ReplayChannelDecl> = {};
  const mergedMeta: Record<string, unknown> = {};
  let hasMeta = false;
  const events: ReplayEvent[] = [];
  const kfMap = new Map<number, Readonly<Record<string, unknown>>>();

  let prevT = first.originMs ?? 0;

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const info = seg.segment!;
    const prefix = `segments[${i}]`;

    if (seg.id !== first.id) {
      throw new ReplayValidationError([{ path: `${prefix}.id`, message: `id mismatch ("${seg.id}" !== "${first.id}")` }]);
    }
    if (seg.host !== first.host) {
      throw new ReplayValidationError([{ path: `${prefix}.host`, message: `host mismatch ("${seg.host}" !== "${first.host}")` }]);
    }
    if (info.index !== i) {
      throw new ReplayValidationError([{ path: `${prefix}.segment.index`, message: `expected ${i}, got ${info.index}` }]);
    }
    if (info.baseSeq !== events.length) {
      throw new ReplayValidationError([{ path: `${prefix}.segment.baseSeq`, message: `expected ${events.length}, got ${info.baseSeq}` }]);
    }

    for (const [ch, decl] of Object.entries(seg.channels)) {
      const existing = channels[ch];
      if (existing && existing.format !== decl.format) {
        throw new ReplayValidationError([{ path: `${prefix}.channels.${ch}`, message: `conflicting format "${decl.format}" vs "${existing.format}"` }]);
      }
      channels[ch] = decl;
    }

    if (seg.meta) {
      Object.assign(mergedMeta, seg.meta);
      hasMeta = true;
    }

    if (i > 0 && info.baseSeq > 0) {
      kfMap.set(info.baseSeq - 1, seg.initialState);
    }

    if (seg.keyframes) {
      for (const kf of seg.keyframes) {
        kfMap.set(info.baseSeq + kf.seq, kf.state);
      }
    }

    for (let j = 0; j < seg.events.length; j++) {
      const ev = seg.events[j]!;
      if (ev.t < prevT) {
        throw new ReplayValidationError([{ path: `${prefix}.events[${j}].t`, message: `timestamp went backwards across segment boundary (${ev.t} < ${prevT})` }]);
      }
      prevT = ev.t;
      events.push(ev);
    }
  }

  const keyframes: ReplayKeyframe[] = [...kfMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, state]) => ({ seq, state }));

  const joined: ReplayBundle = {
    v: 1,
    id: first.id,
    host: first.host,
    ...(first.title !== undefined ? { title: first.title } : {}),
    channels,
    ...(first.originMs !== undefined ? { originMs: first.originMs } : {}),
    ...(first.playback !== undefined ? { playback: first.playback } : {}),
    ...(hasMeta ? { meta: mergedMeta } : {}),
    initialState: first.initialState,
    ...(keyframes.length > 0 ? { keyframes } : {}),
    events,
  };

  return parseBundle(joined);
}

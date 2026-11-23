import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReplayController,
  joinSegments,
  type IReplayChannel,
  type ReplayBundle,
  type ReplayEvent,
} from '../src/index.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createCounterMapAdapter(channel: string, withRestore: boolean) {
  let map: Record<string, number> = {};
  const adapter: IReplayChannel<Record<string, number>> = {
    channel,
    reset(initial) {
      map = initial ? { ...initial } : {};
    },
    ...(withRestore
      ? {
          restore(snap: Record<string, number>) {
            map = { ...snap };
          },
        }
      : {}),
    apply(ev: ReplayEvent) {
      const d = ev.data as { op: 'set' | 'inc' | 'del'; key: string; val: number };
      if (d.op === 'del') delete map[d.key];
      else if (d.op === 'inc') map[d.key] = (map[d.key] ?? 0) + d.val;
      else map[d.key] = d.val;
    },
  };
  return { adapter, snapshot: () => ({ ...map }) };
}

function generateSegmentedBundle(seed: number, segmentCount: number, eventsPerSeg: number): ReplayBundle {
  const rng = mulberry32(seed);
  const channels = { a: { format: 'm@1' }, b: { format: 'm@1' }, log: { format: 'l@1' } };
  const refA = createCounterMapAdapter('a', false);
  const refB = createCounterMapAdapter('b', false);
  refA.adapter.reset({ k0: 1 }, { resolveAssetUrl: async () => undefined });
  refB.adapter.reset({}, { resolveAssetUrl: async () => undefined });

  const segments: ReplayBundle[] = [];
  let t = 0;
  let globalSeq = 0;
  const ctx = { resolveAssetUrl: async () => undefined };

  for (let s = 0; s < segmentCount; s++) {
    const initialState = { a: refA.snapshot(), b: refB.snapshot(), log: null };
    const originMs = t;
    const events: ReplayEvent[] = [];
    for (let i = 0; i < eventsPerSeg; i++) {
      t += Math.floor(rng() * 50);
      const pick = rng();
      const ch = pick < 0.45 ? 'a' : pick < 0.85 ? 'b' : 'log';
      const key = `k${Math.floor(rng() * 5)}`;
      const op = rng() < 0.4 ? 'set' : rng() < 0.8 ? 'inc' : 'del';
      const val = Math.floor(rng() * 10);
      const ev: ReplayEvent = ch === 'log'
        ? { t, ch, k: 'trace', data: { n: globalSeq } }
        : { t, ch, k: op, ...(rng() < 0.2 ? { step: true as const } : {}), data: { op, key, val } };
      if (ch === 'a') refA.adapter.apply(ev, ctx);
      if (ch === 'b') refB.adapter.apply(ev, ctx);
      events.push(ev);
      globalSeq++;
    }
    segments.push({
      v: 1,
      id: `prop-${seed}`,
      host: 'prop',
      channels,
      originMs,
      segment: { index: s, baseSeq: s * eventsPerSeg, ...(s === segmentCount - 1 ? { final: true } : {}) },
      initialState,
      events,
    });
  }

  return joinSegments(segments);
}

test('property: keyframe restore matches sequential replay across random seeks (with & without restore)', () => {
  for (const seed of [1, 42, 1337]) {
    const bundle = generateSegmentedBundle(seed, 5, 25);

    const oracle = new ReplayController();
    const oA = createCounterMapAdapter('a', false);
    const oB = createCounterMapAdapter('b', false);
    oracle.registerChannel(oA.adapter);
    oracle.registerChannel(oB.adapter);
    // Strip keyframes so oracle must always replay from initialState
    const noKfBundle: ReplayBundle = { ...bundle, keyframes: undefined };
    oracle.load(noKfBundle);

    const fast = new ReplayController();
    const fA = createCounterMapAdapter('a', true);
    const fB = createCounterMapAdapter('b', false); // intentionally mixed: one has restore, one doesn't
    fast.registerChannel(fA.adapter);
    fast.registerChannel(fB.adapter);
    fast.load(bundle);

    const rng = mulberry32(seed + 99);
    const total = bundle.events.length;
    for (let step = 0; step < 60; step++) {
      const targetSeq = Math.floor(rng() * (total + 1)) - 1; // [-1, total - 1]
      oracle.seek({ seq: targetSeq });
      fast.seek({ seq: targetSeq });
      assert.deepEqual(fA.snapshot(), oA.snapshot(), `seed=${seed} step=${step} seq=${targetSeq} ch=a`);
      assert.deepEqual(fB.snapshot(), oB.snapshot(), `seed=${seed} step=${step} seq=${targetSeq} ch=b`);
    }
  }
});

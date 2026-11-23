import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReplayController,
  ReplayRecorder,
  joinSegments,
  type IReplayChannel,
  type ISegmentSink,
  type ReplayBundle,
  type SegmentWriteInfo,
} from '../src/index.ts';

function makeDocHarness() {
  let doc: Record<string, number> = {};
  let wall = 1000;
  const written: Array<{ bundle: ReplayBundle; info: SegmentWriteInfo }> = [];

  const sink: ISegmentSink = {
    write(bundle, info) {
      written.push({ bundle, info });
    },
  };

  const recorder = new ReplayRecorder({
    id: 'rec-1',
    host: 'test',
    channels: { doc: { format: 'kv@1' }, diag: { format: 'diag@1' } },
    captures: {
      doc: () => ({ ...doc }),
      diag: () => null,
    },
    sink,
    segment: { maxEvents: 3, maxMs: 10_000, maxBytes: 100_000 },
    now: () => wall,
  });

  const set = (k: string, v: number, step?: true) => {
    doc[k] = v;
    wall += 100;
    return recorder.record({ ch: 'doc', k: 'set', data: { k, v }, ...(step ? { step } : {}) });
  };

  return { docRef: () => doc, advance: (ms: number) => { wall += ms; }, recorder, written, set };
}

test('ReplayRecorder rotates by maxEvents, isolates mutations, and joined replay matches unsegmented', async () => {
  const h = makeDocHarness();
  h.recorder.start();

  const mutablePayload = { k: 'x', v: 1 };
  h.docRef().x = 1;
  assert.equal(h.recorder.record({ ch: 'doc', k: 'set', data: mutablePayload }), 0);
  mutablePayload.v = 999; // must not affect recorded event

  h.set('y', 2);
  h.set('x', 3, true); // triggers rotation #1 (3 events)
  h.set('z', 4);
  h.set('y', 5);
  await h.recorder.stop();

  assert.equal(h.written.length, 2);
  assert.deepEqual(h.written[0]!.info, { index: 0, sealed: true, final: false });
  assert.deepEqual(h.written[1]!.info, { index: 1, sealed: true, final: true });

  // Every segment is independently playable
  const seg1 = h.written[1]!.bundle;
  const ctrlSeg = new ReplayController();
  let state: Record<string, number> = {};
  const adapter: IReplayChannel<Record<string, number>> = {
    channel: 'doc',
    reset(init) { state = init ? { ...init } : {}; },
    restore(snap) { state = { ...snap }; },
    apply(ev) {
      const d = ev.data as { k: string; v: number };
      state[d.k] = d.v;
    },
  };
  ctrlSeg.registerChannel(adapter);
  ctrlSeg.load(seg1);
  ctrlSeg.seek({ edge: 'end' });
  assert.deepEqual(state, { x: 3, y: 5, z: 4 });

  // Joined bundle matches compiled bundle and ends with exact host state
  const joined = joinSegments(h.written.map((w) => w.bundle));
  assert.deepEqual(joined, h.recorder.compile());
  assert.equal((joined.events[0]!.data as { v: number }).v, 1);

  ctrlSeg.load(joined);
  ctrlSeg.seek({ edge: 'end' });
  assert.deepEqual(state, { x: 3, y: 5, z: 4 });
});

test('ReplayRecorder rotates by maxMs and maxBytes, and supports flush(includeOpen)', async () => {
  let t = 0;
  const writes: Array<{ info: SegmentWriteInfo; count: number }> = [];
  let n = 0;

  const rec = new ReplayRecorder({
    id: 'rec-2',
    host: 'test',
    channels: { ch: { format: 'f@1' } },
    captures: { ch: () => n },
    segment: { maxEvents: 100, maxMs: 500, maxBytes: 250 },
    now: () => t,
    sink: {
      write(seg, info) {
        writes.push({ info, count: seg.events.length });
      },
    },
  });

  rec.start();
  n = 1;
  rec.record({ ch: 'ch', data: 'a' });
  await rec.flush({ includeOpen: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.info, { index: 0, sealed: false, final: false });

  t = 600; // triggers maxMs rotation
  n = 2;
  rec.record({ ch: 'ch', data: 'b' });
  await rec.flush();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]!.info, { index: 0, sealed: true, final: false });

  // Large payload triggers maxBytes rotation
  n = 3;
  rec.record({ ch: 'ch', data: 'x'.repeat(260) });
  await rec.stop();
  assert.equal(writes[writes.length - 1]!.info.final, true);
});

test('ReplayRecorder enforces maxSessionBytes and retries failed sink writes', async () => {
  let shouldFail = true;
  const errors: unknown[] = [];
  const delivered: number[] = [];

  const rec = new ReplayRecorder({
    id: 'rec-limit',
    host: 'test',
    channels: { ch: { format: 'f@1' }, diag: { format: 'diag@1' } },
    captures: { ch: () => null, diag: () => null },
    segment: { maxEvents: 2, maxMs: 60_000, maxBytes: 100_000 },
    maxSessionBytes: 160,
    onError: (err) => errors.push(err),
    sink: {
      write(_seg, info) {
        if (shouldFail) throw new Error('network down');
        delivered.push(info.index);
      },
    },
  });

  rec.start();
  assert.equal(rec.record({ ch: 'ch', t: 10, data: 'hello' }), 0);
  assert.equal(rec.record({ ch: 'ch', t: 20, data: 'world' }), 1); // rotates seg 0; sink fails once
  await rec.flush();
  assert.ok(errors.length >= 1);
  assert.equal(rec.pendingCount, 1);

  // Exceed maxSessionBytes -> emits single diag record.limit and stops accepting
  assert.equal(rec.record({ ch: 'ch', t: 30, data: 'y'.repeat(200) }), -1);
  assert.equal(rec.record({ ch: 'ch', t: 40, data: 'after' }), -1);

  shouldFail = false;
  await rec.stop();
  assert.equal(rec.pendingCount, 0);
  assert.deepEqual(delivered, [0, 1]);

  const compiled = rec.compile();
  const last = compiled.events[compiled.events.length - 1]!;
  assert.equal(last.ch, 'diag');
  assert.equal(last.k, 'record.limit');
  assert.equal(last.sev, 'warn');
});

test('ReplayRecorder requires capture() for every channel when segmentation is enabled', () => {
  const rec = new ReplayRecorder({
    id: 'bad',
    host: 'test',
    channels: { a: { format: 'a@1' }, b: { format: 'b@1' } },
    captures: { a: () => ({}) },
  });
  assert.throws(() => rec.start(), /Missing capture/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReplayController,
  type IReplayChannel,
  type IReplayScheduler,
  type ReplayBundle,
  type ReplayEvent,
} from '../src/index.ts';

class FakeScheduler implements IReplayScheduler {
  #now = 0;
  #nextId = 1;
  #pending = new Map<number, (nowMs: number) => void>();

  now(): number {
    return this.#now;
  }

  requestFrame(cb: (nowMs: number) => void): number {
    const id = this.#nextId++;
    this.#pending.set(id, cb);
    return id;
  }

  cancelFrame(handle: number): void {
    this.#pending.delete(handle);
  }

  advance(ms: number): void {
    this.#now += ms;
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, cb] of entries) cb(this.#now);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}

function makeKvAdapter(channel = 'kv') {
  const state = new Map<string, unknown>();
  const phases: string[] = [];
  let batchCalls = 0;
  let applyCalls = 0;

  const adapter: IReplayChannel<Record<string, unknown>> = {
    channel,
    formats: ['kv@1'],
    reset(initial) {
      state.clear();
      if (initial) {
        for (const [k, v] of Object.entries(initial)) state.set(k, v);
      }
    },
    restore(snapshot) {
      state.clear();
      for (const [k, v] of Object.entries(snapshot)) state.set(k, v);
    },
    apply(ev: ReplayEvent) {
      applyCalls++;
      const d = ev.data as { k: string; v: unknown };
      if (ev.k === 'del') state.delete(d.k);
      else state.set(d.k, d.v);
    },
    applyBatch(events) {
      batchCalls++;
      for (const ev of events) {
        const d = ev.data as { k: string; v: unknown };
        if (ev.k === 'del') state.delete(d.k);
        else state.set(d.k, d.v);
      }
    },
    onSeekPhase(phase) {
      phases.push(phase);
    },
  };

  return {
    adapter,
    snapshotObj: () => Object.fromEntries(state.entries()),
    phases,
    get batchCalls() { return batchCalls; },
    get applyCalls() { return applyCalls; },
  };
}

function sampleBundle(): ReplayBundle {
  return {
    v: 1,
    id: 'ctrl-test',
    host: 'test',
    title: 'Controller Test',
    channels: { kv: { format: 'kv@1' } },
    playback: { maxIdleGapMs: 1000, compressedGapMs: 500 },
    initialState: { kv: { init: true } },
    keyframes: [{ seq: 2, state: { kv: { init: true, a: 1, b: 2 } } }],
    events: [
      { t: 0, ch: 'kv', k: 'set', step: true, id: 'ev0', corr: 'c0', data: { k: 'a', v: 1 } },
      { t: 200, ch: 'kv', k: 'set', data: { k: 'b', v: 2 } },
      { t: 2200, ch: 'kv', k: 'set', step: true, id: 'ev2', corr: 'c2', data: { k: 'a', v: 1 } },
      { t: 2400, ch: 'kv', k: 'set', step: true, id: 'ev3', corr: 'c3', data: { k: 'c', v: 3 } },
    ],
  };
}

test('ReplayController lifecycle: load, play, idle gap, ended, replay', () => {
  const sched = new FakeScheduler();
  const ctrl = new ReplayController({ scheduler: sched });
  const kv = makeKvAdapter();
  ctrl.registerChannel(kv.adapter);

  const initialSnap = ctrl.snapshot;
  assert.equal(initialSnap.status, 'idle');
  assert.equal(ctrl.snapshot, initialSnap); // stable reference

  ctrl.load(sampleBundle());
  assert.equal(ctrl.snapshot.status, 'ready');
  assert.equal(ctrl.snapshot.currentSeq, -1);
  assert.equal(ctrl.snapshot.totalSteps, 3);
  assert.equal(ctrl.snapshot.totalDurationMs, 200 + 500 + 200);
  assert.deepEqual(kv.snapshotObj(), { init: true });

  ctrl.play();
  assert.equal(ctrl.snapshot.status, 'playing');
  // t=0 event applies immediately on play()
  assert.equal(ctrl.snapshot.currentSeq, 0);
  assert.equal(ctrl.snapshot.activeCorr, 'c0');
  assert.deepEqual(kv.snapshotObj(), { init: true, a: 1 });

  sched.advance(200);
  assert.equal(ctrl.snapshot.currentSeq, 1);
  assert.deepEqual(kv.snapshotObj(), { init: true, a: 1, b: 2 });

  // Inside compressed 2000ms idle gap (compressed to 500ms)
  sched.advance(250);
  assert.equal(ctrl.snapshot.currentSeq, 1);
  assert.deepEqual(ctrl.snapshot.activeIdleGap, { rawGapMs: 2000 });

  // Finish gap + final event
  sched.advance(250);
  assert.equal(ctrl.snapshot.currentSeq, 2);
  assert.equal(ctrl.snapshot.activeIdleGap, null);

  sched.advance(200);
  assert.equal(ctrl.snapshot.status, 'ended');
  assert.equal(ctrl.snapshot.currentSeq, 3);
  assert.equal(sched.pendingCount, 0);
  assert.deepEqual(kv.snapshotObj(), { init: true, a: 1, b: 2, c: 3 });

  // Play from ended restarts from initial state
  ctrl.play();
  assert.equal(ctrl.snapshot.status, 'playing');
  assert.equal(ctrl.snapshot.currentSeq, 0);
  assert.deepEqual(kv.snapshotObj(), { init: true, a: 1 });

  ctrl.pause();
  assert.equal(ctrl.snapshot.status, 'paused');
  assert.equal(sched.pendingCount, 0);
  ctrl.dispose();
});

test('ReplayController seek targets, step, skipIdle toggle, and speed', () => {
  const sched = new FakeScheduler();
  const ctrl = new ReplayController({ scheduler: sched });
  const kv = makeKvAdapter();
  ctrl.registerChannel(kv.adapter);
  ctrl.load(sampleBundle());

  assert.equal(ctrl.seek({ eventId: 'missing' }), false);

  assert.equal(ctrl.seek({ eventId: 'ev3' }), true);
  assert.equal(ctrl.snapshot.status, 'ended');
  assert.equal(ctrl.snapshot.currentSeq, 3);
  assert.equal(ctrl.snapshot.currentStepIndex, 2);
  assert.deepEqual(kv.snapshotObj(), { init: true, a: 1, b: 2, c: 3 });

  // Step backward skips non-step event at seq=1 and lands on seq=2 then seq=0
  assert.equal(ctrl.step(-1), true);
  assert.equal(ctrl.snapshot.currentSeq, 2);
  assert.equal(ctrl.snapshot.status, 'paused');
  assert.deepEqual(kv.phases, ['start', 'end', 'start', 'end']);

  assert.equal(ctrl.step(-1), true);
  assert.equal(ctrl.snapshot.currentSeq, 0);

  assert.equal(ctrl.step(-1), true);
  assert.equal(ctrl.snapshot.currentSeq, -1);
  assert.deepEqual(kv.snapshotObj(), { init: true });

  assert.equal(ctrl.step(-1), false);

  // Seek by time inside idle gap & toggle skipIdle keeping rawTimeMs
  ctrl.seek({ time: 450 }); // 200 + 250 (half of 500ms compressed = raw 1200ms)
  assert.equal(ctrl.snapshot.rawTimeMs, 1200);
  ctrl.setSkipIdle(false);
  assert.equal(ctrl.snapshot.rawTimeMs, 1200);
  assert.equal(ctrl.snapshot.currentTimeMs, 1200);
  assert.equal(ctrl.snapshot.totalDurationMs, 2400);

  // Speed & batch apply
  ctrl.setSpeed(2);
  ctrl.play();
  sched.advance(250); // 250ms * 2 = 500ms -> raw 1700ms
  assert.equal(ctrl.snapshot.rawTimeMs, 1700);
  assert.throws(() => ctrl.setSpeed(0), RangeError);

  ctrl.seek({ edge: 'start' });
  const beforeBatch = kv.batchCalls;
  ctrl.seek({ seq: 1 });
  assert.equal(kv.batchCalls, beforeBatch + 1);

  ctrl.dispose();
});

test('ReplayController surfaces format mismatch, empty bundle, and adapter errors', () => {
  const ctrl = new ReplayController();
  ctrl.registerChannel({
    channel: 'kv',
    formats: ['kv@99'],
    reset() {},
    apply() {},
  });
  ctrl.load(sampleBundle());
  assert.equal(ctrl.snapshot.status, 'error');
  assert.match(ctrl.snapshot.error ?? '', /format mismatch/);

  // Empty bundle goes straight to ended on play
  const ctrl2 = new ReplayController();
  ctrl2.load({
    v: 1,
    id: 'empty',
    host: 'test',
    channels: { kv: { format: 'kv@1' } },
    initialState: { kv: {} },
    events: [],
  });
  assert.equal(ctrl2.snapshot.status, 'ready');
  ctrl2.play();
  assert.equal(ctrl2.snapshot.status, 'ended');

  // Throwing adapter transitions controller to error without crashing caller
  const ctrl3 = new ReplayController();
  ctrl3.registerChannel({
    channel: 'kv',
    reset() {},
    apply() {
      throw new Error('boom');
    },
  });
  ctrl3.load(sampleBundle());
  ctrl3.seek({ seq: 0 });
  assert.equal(ctrl3.snapshot.status, 'error');
  assert.match(ctrl3.snapshot.error ?? '', /\[kv\] boom/);
});

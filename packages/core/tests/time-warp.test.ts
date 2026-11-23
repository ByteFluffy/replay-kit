import assert from 'node:assert/strict';
import test from 'node:test';
import { TimeWarp } from '../src/index.ts';

test('TimeWarp handles empty and zero-timestamp streams', () => {
  const empty = TimeWarp.build([], { enabled: true, maxIdleGapMs: 1000, compressedGapMs: 500 });
  assert.equal(empty.rawDurationMs, 0);
  assert.equal(empty.totalWarpedMs, 0);
  assert.equal(empty.rawToWarped(100), 0);
  assert.equal(empty.warpedToRaw(100), 0);
  assert.equal(empty.idleGapAt(0), null);

  const zeros = TimeWarp.build([0, 0, 0], { enabled: true, maxIdleGapMs: 1000, compressedGapMs: 500 });
  assert.equal(zeros.rawDurationMs, 0);
  assert.equal(zeros.totalWarpedMs, 0);
});

test('TimeWarp compresses long idle gaps and round-trips raw <-> warped', () => {
  // 0 -> 500 (normal, 500ms)
  // 500 -> 10500 (idle 10000ms -> compressed to 800ms)
  // 10500 -> 11500 (normal, 1000ms)
  const tw = TimeWarp.build([0, 500, 10500, 11500], {
    enabled: true,
    maxIdleGapMs: 1000,
    compressedGapMs: 800,
  });

  assert.equal(tw.rawDurationMs, 11500);
  assert.equal(tw.totalWarpedMs, 500 + 800 + 1000);

  assert.equal(tw.rawToWarped(0), 0);
  assert.equal(tw.rawToWarped(500), 500);
  assert.equal(tw.rawToWarped(5500), 900); // midpoint of idle gap
  assert.equal(tw.rawToWarped(10500), 1300);
  assert.equal(tw.rawToWarped(11500), 2300);

  for (const r of [0, 250, 500, 3000, 5500, 10500, 11000, 11500]) {
    const w = tw.rawToWarped(r);
    assert.ok(Math.abs(tw.warpedToRaw(w) - r) < 1e-6, `round-trip failed at raw=${r}`);
  }

  assert.equal(tw.idleGapAt(500), null);
  assert.deepEqual(tw.idleGapAt(5500), {
    rawGapMs: 10000,
    rawStartMs: 500,
    rawEndMs: 10500,
  });
  assert.equal(tw.idleGapAt(10500), null);
});

test('TimeWarp handles compressedGapMs = 0 and disabled mode', () => {
  const zeroGap = TimeWarp.build([0, 100, 5100, 5200], {
    enabled: true,
    maxIdleGapMs: 1000,
    compressedGapMs: 0,
  });
  assert.equal(zeroGap.totalWarpedMs, 200);
  assert.equal(zeroGap.rawToWarped(2500), 100);
  assert.equal(zeroGap.warpedToRaw(100), 5100);

  const disabled = TimeWarp.build([0, 100, 5100, 5200], {
    enabled: false,
    maxIdleGapMs: 1000,
    compressedGapMs: 500,
  });
  assert.equal(disabled.totalWarpedMs, 5200);
  assert.equal(disabled.idleGapAt(2500), null);
});

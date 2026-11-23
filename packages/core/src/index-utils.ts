import type { ReplayEvent, ReplayKeyframe } from './protocol.ts';

const EPS = 1e-6;

/** Index of the last keyframe with `seq <= target`, or -1. */
export function findKeyframeIndex(keyframes: readonly ReplayKeyframe[], target: number): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid]!.seq <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Index of the last time `<= raw`, or -1. `times` must be non-decreasing. */
export function lastSeqAtOrBefore(times: readonly number[], raw: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  const limit = raw + EPS;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= limit) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Sequence numbers of events flagged `step: true`. */
export function buildStepIndex(events: readonly ReplayEvent[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i]!.step) out.push(i);
  return out;
}

/** Index into `stepSeqs` of the last step with `seq <= target`, or -1. */
export function stepIndexAtOrBefore(stepSeqs: readonly number[], target: number): number {
  let lo = 0;
  let hi = stepSeqs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stepSeqs[mid]! <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

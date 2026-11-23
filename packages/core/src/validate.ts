import type { ReplayBundle } from './protocol.ts';

export type ReplayIssue = { readonly path: string; readonly message: string };

export class ReplayValidationError extends Error {
  readonly issues: readonly ReplayIssue[];

  constructor(issues: readonly ReplayIssue[]) {
    const head = issues
      .slice(0, 5)
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`Invalid ReplayBundle: ${head}${more}`);
    this.name = 'ReplayValidationError';
    this.issues = issues;
  }
}

const MAX_ISSUES = 50;

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/** Returns every problem found (capped at 50); empty array means valid. */
export function validateBundle(input: unknown): readonly ReplayIssue[] {
  const issues: ReplayIssue[] = [];
  const add = (path: string, message: string): void => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  if (!isRecord(input)) return [{ path: '', message: 'bundle must be an object' }];
  if (input.v !== 1) add('v', 'must be 1');
  if (!isNonEmptyString(input.id)) add('id', 'must be a non-empty string');
  if (!isNonEmptyString(input.host)) add('host', 'must be a non-empty string');
  if (input.title !== undefined && typeof input.title !== 'string') add('title', 'must be a string');

  const declared = new Set<string>();
  let channelsValid = false;
  if (!isRecord(input.channels)) {
    add('channels', 'must be an object');
  } else {
    channelsValid = true;
    for (const [name, decl] of Object.entries(input.channels)) {
      declared.add(name);
      if (!isRecord(decl) || !isNonEmptyString(decl.format)) {
        add(`channels.${name}.format`, 'must be a non-empty string');
      }
    }
  }

  let origin = 0;
  if (input.originMs !== undefined) {
    if (typeof input.originMs !== 'number' || !Number.isFinite(input.originMs) || input.originMs < 0) {
      add('originMs', 'must be a finite number >= 0');
    } else {
      origin = input.originMs;
    }
  }

  if (input.segment !== undefined) {
    const seg = input.segment;
    if (
      !isRecord(seg) ||
      !Number.isInteger(seg.index) ||
      (seg.index as number) < 0 ||
      !Number.isInteger(seg.baseSeq) ||
      (seg.baseSeq as number) < 0 ||
      (seg.final !== undefined && typeof seg.final !== 'boolean')
    ) {
      add('segment', 'index and baseSeq must be integers >= 0');
    }
  }

  if (input.playback !== undefined) {
    const pb = input.playback;
    if (!isRecord(pb)) {
      add('playback', 'must be an object');
    } else {
      if (pb.maxIdleGapMs !== undefined && (typeof pb.maxIdleGapMs !== 'number' || !Number.isFinite(pb.maxIdleGapMs) || pb.maxIdleGapMs < 0)) {
        add('playback.maxIdleGapMs', 'must be a finite number >= 0');
      }
      if (pb.compressedGapMs !== undefined && (typeof pb.compressedGapMs !== 'number' || !Number.isFinite(pb.compressedGapMs) || pb.compressedGapMs < 0)) {
        add('playback.compressedGapMs', 'must be a finite number >= 0');
      }
      if (pb.speed !== undefined && (typeof pb.speed !== 'number' || !Number.isFinite(pb.speed) || pb.speed <= 0)) {
        add('playback.speed', 'must be a finite number > 0');
      }
    }
  }

  if (input.meta !== undefined && !isRecord(input.meta)) add('meta', 'must be an object');
  if (!isRecord(input.initialState)) add('initialState', 'must be an object');

  const events = input.events;
  let eventCount = 0;
  if (!Array.isArray(events)) {
    add('events', 'must be an array');
  } else {
    eventCount = events.length;
    const ids = new Set<string>();
    let prevT = origin;
    for (let i = 0; i < events.length; i++) {
      const e: unknown = events[i];
      const p = `events[${i}]`;
      if (!isRecord(e)) {
        add(p, 'must be an object');
        continue;
      }
      if (typeof e.t !== 'number' || !Number.isFinite(e.t)) {
        add(`${p}.t`, 'must be a finite number');
      } else {
        if (e.t < prevT) add(`${p}.t`, `must be >= previous (${e.t} < ${prevT})`);
        prevT = Math.max(prevT, e.t);
      }
      if (!isNonEmptyString(e.ch)) {
        add(`${p}.ch`, 'must be a non-empty string');
      } else if (channelsValid && !declared.has(e.ch)) {
        add(`${p}.ch`, `channel "${e.ch}" is not declared in channels`);
      }
      if (e.k !== undefined && typeof e.k !== 'string') add(`${p}.k`, 'must be a string');
      if (e.step !== undefined && e.step !== true) add(`${p}.step`, 'must be true when present');
      if (e.corr !== undefined && typeof e.corr !== 'string') add(`${p}.corr`, 'must be a string');
      if (e.sev !== undefined && e.sev !== 'warn' && e.sev !== 'error') add(`${p}.sev`, 'must be "warn" or "error"');
      if (e.id !== undefined) {
        if (typeof e.id !== 'string' || e.id.length === 0) add(`${p}.id`, 'must be a non-empty string');
        else if (ids.has(e.id)) add(`${p}.id`, `duplicate event id "${e.id}"`);
        else ids.add(e.id);
      }
      if (issues.length >= MAX_ISSUES) break;
    }
  }

  const keyframes = input.keyframes;
  if (keyframes !== undefined) {
    if (!Array.isArray(keyframes)) {
      add('keyframes', 'must be an array');
    } else {
      let prev = -1;
      for (let i = 0; i < keyframes.length; i++) {
        const kf: unknown = keyframes[i];
        const p = `keyframes[${i}]`;
        if (!isRecord(kf)) {
          add(p, 'must be an object');
          continue;
        }
        if (!Number.isInteger(kf.seq) || (kf.seq as number) < 0 || (kf.seq as number) >= eventCount) {
          add(`${p}.seq`, `must be an integer in [0, ${eventCount})`);
        } else if ((kf.seq as number) <= prev) {
          add(`${p}.seq`, 'must be strictly increasing');
        } else {
          prev = kf.seq as number;
        }
        if (!isRecord(kf.state)) add(`${p}.state`, 'must be an object');
      }
    }
  }

  return issues;
}

/** Validates an untrusted value and returns it typed, or throws `ReplayValidationError`. */
export function parseBundle(input: unknown): ReplayBundle {
  const issues = validateBundle(input);
  if (issues.length > 0) throw new ReplayValidationError(issues);
  return input as ReplayBundle;
}

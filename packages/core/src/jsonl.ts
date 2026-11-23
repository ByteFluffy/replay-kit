import type { ReplayBundle, ReplayEvent, ReplayKeyframe } from './protocol.ts';
import { isRecord, parseBundle, ReplayValidationError } from './validate.ts';

export type DecodeJsonlOptions = {
  /** Drop an unparseable last line (e.g. an open segment interrupted mid-write). */
  readonly tolerateTruncatedTail?: boolean;
};

/** Encodes a ReplayBundle as JSONL: line 1 header, followed by events and inline keyframes. */
export function encodeJsonl(bundle: ReplayBundle): string {
  const valid = parseBundle(bundle);
  const header: Record<string, unknown> = {
    type: 'header',
    v: valid.v,
    id: valid.id,
    host: valid.host,
  };
  if (valid.title !== undefined) header.title = valid.title;
  header.channels = valid.channels;
  if (valid.originMs !== undefined) header.originMs = valid.originMs;
  if (valid.segment !== undefined) header.segment = valid.segment;
  if (valid.playback !== undefined) header.playback = valid.playback;
  if (valid.meta !== undefined) header.meta = valid.meta;
  header.initialState = valid.initialState;

  const kfBySeq = new Map<number, ReplayKeyframe>();
  if (valid.keyframes) {
    for (const kf of valid.keyframes) kfBySeq.set(kf.seq, kf);
  }

  const lines: string[] = [JSON.stringify(header)];
  for (let i = 0; i < valid.events.length; i++) {
    lines.push(JSON.stringify(valid.events[i]));
    const kf = kfBySeq.get(i);
    if (kf) lines.push(JSON.stringify({ type: 'keyframe', seq: kf.seq, state: kf.state }));
  }
  return `${lines.join('\n')}\n`;
}

/** Decodes and validates a JSONL replay stream. */
export function decodeJsonl(text: string, options?: DecodeJsonlOptions): ReplayBundle {
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.trim().length > 0) lines.push(line);
  }
  if (lines.length === 0) {
    throw new ReplayValidationError([{ path: '', message: 'empty JSONL stream' }]);
  }

  const parsedLines: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    try {
      parsedLines.push(JSON.parse(lines[i]!));
    } catch {
      if (isLast && i > 0 && options?.tolerateTruncatedTail) break;
      throw new ReplayValidationError([{ path: `line:${i + 1}`, message: 'invalid JSON' }]);
    }
  }

  const first = parsedLines[0];
  if (!isRecord(first) || first.type !== 'header') {
    throw new ReplayValidationError([{ path: 'line:1', message: 'first line must be a header object' }]);
  }

  const { type: _headerType, ...headerRest } = first;
  const events: ReplayEvent[] = [];
  const keyframes: ReplayKeyframe[] = [];

  for (let i = 1; i < parsedLines.length; i++) {
    const item = parsedLines[i];
    if (isRecord(item) && item.type === 'keyframe') {
      keyframes.push({ seq: item.seq as number, state: item.state as Record<string, unknown> });
    } else {
      events.push(item as ReplayEvent);
    }
  }

  const candidate: Record<string, unknown> = {
    ...headerRest,
    events,
  };
  if (keyframes.length > 0) candidate.keyframes = keyframes;

  return parseBundle(candidate);
}

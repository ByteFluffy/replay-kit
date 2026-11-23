import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ReplayController,
  decodeJsonl,
  joinSegments,
  type IReplayChannel,
} from '../src/index.ts';

const conformanceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../conformance',
);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(conformanceDir, name), 'utf8');
}

test('conformance: minimal-chat fixture replays and steps cleanly', () => {
  const bundle = decodeJsonl(readFixture('minimal-chat.jsonl'));
  const ctrl = new ReplayController();
  const log: string[] = [];
  const adapter: IReplayChannel = {
    channel: 'agent',
    formats: ['chat-msg@1'],
    reset() { log.length = 0; },
    apply(ev) { log.push(`${ev.k ?? ''}:${ev.t}`); },
  };
  ctrl.registerChannel(adapter);
  ctrl.load(bundle);
  assert.equal(ctrl.snapshot.status, 'ready');
  assert.equal(ctrl.snapshot.totalSteps, 4);

  ctrl.step(1);
  ctrl.step(1);
  assert.equal(ctrl.snapshot.activeCorr, 'tc_1');
  ctrl.seek({ edge: 'end' });
  assert.equal(ctrl.snapshot.status, 'ended');
  assert.equal(log.length, 5);
});

test('conformance: multi-channel-idle fixture compresses idle gap and tracks diag severity', () => {
  const bundle = decodeJsonl(readFixture('multi-channel-idle.jsonl'));
  const ctrl = new ReplayController();
  const doc: Record<string, unknown> = {};
  ctrl.registerChannel({
    channel: 'doc',
    formats: ['patch@1'],
    reset(init) {
      for (const k of Object.keys(doc)) delete doc[k];
      if (init && typeof init === 'object') Object.assign(doc, init);
    },
    apply(ev) {
      const d = ev.data as { key: string; value: unknown };
      doc[d.key] = d.value;
    },
  });
  ctrl.load(bundle);
  // 20000ms gap compressed to 500ms
  assert.equal(ctrl.snapshot.rawDurationMs, 21100);
  assert.equal(ctrl.snapshot.totalDurationMs, 400 + 500 + 500 + 200);
  ctrl.seek({ eventId: 'doc_set_1' });
  assert.deepEqual(doc, { bg: 'sky' });
  ctrl.seek({ edge: 'end' });
  assert.deepEqual(doc, { bg: 'sky', fg: 'hero' });
});

test('conformance: segmented fixtures join and replay to final state', () => {
  const s0 = decodeJsonl(readFixture('segment-0.jsonl'));
  const s1 = decodeJsonl(readFixture('segment-1.jsonl'));
  const joined = joinSegments([s0, s1]);

  let kv: Record<string, number> = {};
  const ctrl = new ReplayController();
  ctrl.registerChannel({
    channel: 'doc',
    formats: ['kv@1'],
    reset(init) { kv = init ? { ...(init as Record<string, number>) } : {}; },
    restore(snap) { kv = { ...(snap as Record<string, number>) }; },
    apply(ev) {
      const d = ev.data as { k: string; v?: number };
      if (ev.k === 'del') delete kv[d.k];
      else kv[d.k] = d.v!;
    },
  });
  ctrl.load(joined);
  ctrl.seek({ edge: 'end' });
  assert.deepEqual(kv, { a: 10 });
  ctrl.seek({ seq: 1 });
  assert.deepEqual(kv, { a: 1, b: 2 });
});

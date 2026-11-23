import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReplayValidationError,
  decodeJsonl,
  encodeJsonl,
  parseBundle,
  validateBundle,
  type ReplayBundle,
} from '../src/index.ts';

function validBundle(): ReplayBundle {
  return {
    v: 1,
    id: 'bundle-1',
    host: 'test-host',
    title: 'Sample',
    channels: {
      agent: { format: 'chat@1' },
      doc: { format: 'kv@1' },
    },
    originMs: 0,
    initialState: { agent: [], doc: {} },
    keyframes: [{ seq: 1, state: { agent: ['hi'], doc: { a: 1 } } }],
    events: [
      { t: 0, ch: 'agent', k: 'msg', step: true, id: 'e0', data: 'hi' },
      { t: 100, ch: 'doc', k: 'set', corr: 'c1', data: { a: 1 } },
      { t: 250, ch: 'doc', k: 'warn', sev: 'warn', data: { code: 'x' } },
    ],
  };
}

test('validateBundle accepts a valid bundle', () => {
  const b = validBundle();
  assert.deepEqual(validateBundle(b), []);
  assert.equal(parseBundle(b), b);
});

test('validateBundle rejects malformed bundles', () => {
  const cases: Array<[string, unknown]> = [
    ['non-object', null],
    ['wrong version', { ...validBundle(), v: 2 }],
    ['empty id', { ...validBundle(), id: '' }],
    ['empty host', { ...validBundle(), host: '' }],
    ['missing format', { ...validBundle(), channels: { agent: { format: '' } } }],
    ['negative originMs', { ...validBundle(), originMs: -1 }],
    ['t before origin', { ...validBundle(), originMs: 50, events: [{ t: 10, ch: 'agent' }] }],
    ['t goes backwards', { ...validBundle(), events: [{ t: 200, ch: 'agent' }, { t: 100, ch: 'agent' }] }],
    ['undeclared channel', { ...validBundle(), events: [{ t: 0, ch: 'unknown' }] }],
    ['step !== true', { ...validBundle(), events: [{ t: 0, ch: 'agent', step: false }] }],
    ['bad sev', { ...validBundle(), events: [{ t: 0, ch: 'agent', sev: 'fatal' }] }],
    ['duplicate event id', { ...validBundle(), events: [{ t: 0, ch: 'agent', id: 'dup' }, { t: 1, ch: 'agent', id: 'dup' }] }],
    ['keyframe out of range', { ...validBundle(), keyframes: [{ seq: 10, state: {} }] }],
    ['keyframes not strictly increasing', { ...validBundle(), keyframes: [{ seq: 1, state: {} }, { seq: 1, state: {} }] }],
    ['invalid playback speed', { ...validBundle(), playback: { speed: 0 } }],
  ];

  for (const [label, input] of cases) {
    const issues = validateBundle(input);
    assert.ok(issues.length > 0, `expected issues for: ${label}`);
    assert.throws(() => parseBundle(input), ReplayValidationError, `expected throw for: ${label}`);
  }
});

test('encodeJsonl / decodeJsonl round-trips bundle with keyframes', () => {
  const original = validBundle();
  const text = encodeJsonl(original);
  const decoded = decodeJsonl(text);
  assert.deepEqual(decoded, original);
});

test('decodeJsonl tolerates truncated tail line only when enabled', () => {
  const text = encodeJsonl(validBundle());
  const withGarbageTail = `${text}{"t":300,"ch":"doc","data":{"partial":`;

  assert.throws(() => decodeJsonl(withGarbageTail), ReplayValidationError);

  const recovered = decodeJsonl(withGarbageTail, { tolerateTruncatedTail: true });
  assert.equal(recovered.events.length, 3);
  assert.deepEqual(recovered.keyframes, validBundle().keyframes);
});

test('decodeJsonl fails on empty or non-header first line', () => {
  assert.throws(() => decodeJsonl(''), ReplayValidationError);
  assert.throws(() => decodeJsonl('{"t":0,"ch":"a"}\n'), ReplayValidationError);
  assert.throws(() => decodeJsonl('{broken', { tolerateTruncatedTail: true }), ReplayValidationError);
});

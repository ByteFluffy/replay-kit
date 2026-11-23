# replay-kit

Framework-agnostic, zero-dependency record & replay engine for workspace and agent sessions.

See [PROTOCOL.md](./PROTOCOL.md) for the v1 bundle, JSONL, segmentation, adapter, and recorder specifications.

## Packages

- `@replay-kit/core` — Protocol types & validator, JSONL codec, segment joiner, piecewise-linear idle-time compressor (`TimeWarp`), state machine (`ReplayController`), and segmenting recorder (`ReplayRecorder`). Zero runtime dependencies; no DOM or Node assumptions.

## Quickstart

```ts
import {
  ReplayController,
  ReplayRecorder,
  type IReplayChannel,
} from '@replay-kit/core';

let count = 0;

const recorder = new ReplayRecorder({
  id: 'session-1',
  host: 'example',
  channels: { counter: { format: 'counter@1' } },
  captures: { counter: () => count },
});

recorder.start();
count += 1;
recorder.record({ ch: 'counter', k: 'inc', step: true, data: 1 });
await recorder.stop();

const bundle = recorder.compile();

const controller = new ReplayController();
const adapter: IReplayChannel<number> = {
  channel: 'counter',
  formats: ['counter@1'],
  reset(initial) {
    count = initial ?? 0;
  },
  restore(snapshot) {
    count = snapshot;
  },
  apply(event) {
    count += event.data as number;
  },
};

controller.registerChannel(adapter);
controller.load(bundle);
controller.play();
```

## Development

```bash
cd packages/core
tsc -p tsconfig.json --noEmit
node --test "tests/*.test.ts"
tsc -p tsconfig.build.json
```

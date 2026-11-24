# `replay-kit-core`

Framework-agnostic, zero-dependency record & replay engine for collaborative workspaces, AI agents, and structured diagnostics.

- Protocol specification: [`PROTOCOL.md`](../../PROTOCOL.md)
- Repository architecture & conformance fixtures: [ByteFluffy/replay-kit](https://github.com/ByteFluffy/replay-kit)

## Installation

```bash
pnpm add replay-kit-core
```

## Exported Surface

- **Protocol & Codec**: `validateBundle`, `parseBundle`, `ReplayValidationError`, `encodeJsonl`, `decodeJsonl`, `joinSegments`, `DEFAULT_MAX_IDLE_GAP_MS`, `DEFAULT_COMPRESSED_GAP_MS`, `DEFAULT_SPEED`
- **Time Compression**: `TimeWarp` (`rawToWarped`, `warpedToRaw`, `idleGapAt`)
- **Playback Engine**: `ReplayController` (`registerChannel`, `load`, `play`, `pause`, `seek`, `step`, `setSpeed`, `setSkipIdle`, `subscribe`, `snapshot`, `dispose`) and `IReplayChannel`
- **Segmented Recorder**: `ReplayRecorder` (`start`, `record`, `flush`, `stop`, `compile`) and `ISegmentSink`

## Usage Example

```ts
import {
  ReplayController,
  ReplayRecorder,
  decodeJsonl,
  encodeJsonl,
  joinSegments,
  type IReplayChannel,
} from 'replay-kit-core';

let state = 0;

const recorder = new ReplayRecorder({
  id: 'sess-1',
  host: 'app',
  channels: { state: { format: 'counter@1' } },
  captures: { state: () => state },
});

recorder.start();
state += 5;
recorder.record({ ch: 'state', k: 'add', step: true, data: 5 });
await recorder.stop();

const jsonl = encodeJsonl(recorder.compile());
const bundle = joinSegments([decodeJsonl(jsonl)]);

const controller = new ReplayController();
const adapter: IReplayChannel<number> = {
  channel: 'state',
  formats: ['counter@1'],
  reset(initial) {
    state = initial ?? 0;
  },
  restore(snapshot) {
    state = snapshot;
  },
  apply(event) {
    state += event.data as number;
  },
};

controller.registerChannel(adapter);
controller.load(bundle);
controller.seek({ edge: 'end' });
```

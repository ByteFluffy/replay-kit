export {
  DEFAULT_COMPRESSED_GAP_MS,
  DEFAULT_MAX_IDLE_GAP_MS,
  DEFAULT_SPEED,
  type ReplayBundle,
  type ReplayChannelDecl,
  type ReplayEvent,
  type ReplayKeyframe,
  type ReplayPlaybackPolicy,
  type ReplaySegmentInfo,
  type ReplaySeverity,
} from './protocol.ts';

export {
  ReplayValidationError,
  parseBundle,
  validateBundle,
  type ReplayIssue,
} from './validate.ts';

export {
  decodeJsonl,
  encodeJsonl,
  type DecodeJsonlOptions,
} from './jsonl.ts';

export { joinSegments } from './join.ts';

export {
  TimeWarp,
  type IdleGap,
  type TimeWarpOptions,
} from './time-warp.ts';

export type {
  IReplayChannel,
  ReplayAdapterContext,
} from './channel.ts';

export {
  ReplayController,
  type IReplayScheduler,
  type ReplayControllerOptions,
  type ReplaySeekTarget,
  type ReplaySnapshot,
  type ReplayStatus,
} from './controller.ts';

export {
  ReplayRecorder,
  type ISegmentSink,
  type RecordEventInput,
  type ReplayRecorderOptions,
  type ReplaySegmentPolicy,
  type SegmentWriteInfo,
} from './recorder.ts';

import {
  presentationCutoff,
  type PublicStreamDefinition,
} from "./public-stream";

export interface PublicStreamRetentionStore {
  deletePointsBeyond(limit: number): number;
  deletePointsOutside(cutoff: number, now: number): number;
  deleteReplayBeyond(limit: number): number;
  deleteReplayContainingPointsBefore(cutoff: number): number;
  deleteReplayOutside(cutoff: number, now: number): number;
}

export interface RetentionResult {
  pointsDeleted: number;
  replayDeleted: number;
  timeExpired: boolean;
}

/** Enforces one stream definition against physical point and replay storage. */
export function enforcePublicStreamRetention(
  stream: PublicStreamDefinition,
  store: PublicStreamRetentionStore,
  now: number,
): RetentionResult {
  const cutoff = presentationCutoff(stream, now);
  const outsidePoints = store.deletePointsOutside(cutoff, now);
  const overflowPoints = store.deletePointsBeyond(stream.presentation.maxPoints);
  const outsideReplay = store.deleteReplayOutside(cutoff, now);
  const overflowReplay = store.deleteReplayBeyond(stream.replayLimit);
  const invalidatedReplay = store.deleteReplayContainingPointsBefore(cutoff);

  return {
    pointsDeleted: outsidePoints + overflowPoints,
    replayDeleted: outsideReplay + overflowReplay + invalidatedReplay,
    timeExpired: outsidePoints > 0,
  };
}

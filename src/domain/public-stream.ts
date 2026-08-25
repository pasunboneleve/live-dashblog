export interface PresentationWindow {
  durationMs: number;
  maxPoints: number;
}

export interface PublicStreamDefinition<Name extends string = string> {
  broadcastIntervalMs: number;
  name: Name;
  presentation: PresentationWindow;
  replayLimit: number;
}

export interface PresentedPoint {
  observedAt: number;
}

interface PublicStreamInput<Name extends string> {
  broadcastIntervalMs: number;
  name: Name;
  presentation: PresentationWindow;
}

/** Defines the window that every layer of one allowlisted public stream must enforce. */
export function definePublicStream<const Name extends string>(
  input: PublicStreamInput<Name>,
): PublicStreamDefinition<Name> {
  if (!Number.isSafeInteger(input.presentation.durationMs) || input.presentation.durationMs <= 0) {
    throw new RangeError("A public stream presentation duration must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.presentation.maxPoints) || input.presentation.maxPoints <= 0) {
    throw new RangeError("A public stream presentation point cap must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.broadcastIntervalMs) || input.broadcastIntervalMs <= 0) {
    throw new RangeError("A public stream broadcast interval must be a positive integer.");
  }

  return Object.freeze({
    ...input,
    presentation: Object.freeze({ ...input.presentation }),
    replayLimit: Math.ceil(input.presentation.durationMs / input.broadcastIntervalMs) + 1,
  });
}

export function presentationCutoff(
  stream: PublicStreamDefinition,
  now: number,
): number {
  return now - stream.presentation.durationMs;
}

/** Returns only points eligible for the current inclusive time range and capacity. */
export function selectPresentablePoints<Point extends PresentedPoint>(
  stream: PublicStreamDefinition,
  points: readonly Point[],
  now: number,
): Point[] {
  const cutoff = presentationCutoff(stream, now);
  return points
    .filter((point) => point.observedAt >= cutoff && point.observedAt <= now)
    .slice(-stream.presentation.maxPoints);
}

/** Schedules one millisecond beyond the inclusive boundary so the oldest point has expired. */
export function nextPresentationExpiry(
  stream: PublicStreamDefinition,
  points: readonly PresentedPoint[],
  now: number,
): number | null {
  const presentable = selectPresentablePoints(stream, points, now);
  const oldest = presentable[0];
  return oldest ? oldest.observedAt + stream.presentation.durationMs + 1 : null;
}

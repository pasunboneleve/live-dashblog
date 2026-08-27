import {
  OBSERVABILITY_STREAM_NAME,
  acceptObservabilityEnvelope,
  acceptObservabilitySnapshot,
  projectPublicObservability,
  type PublicObservabilityProjection,
} from "../domain/public-observability";
import {
  recordTelemetryFinalPaint,
  recordTelemetryReducerApplication,
  telemetryFetch,
  telemetryWebSocket,
} from "../telemetry/browser-telemetry-hooks";

type ProjectionRenderer = (projection: PublicObservabilityProjection) => void;
interface Subscription { active: boolean; render: ProjectionRenderer }

const subscriptions = new Set<Subscription>();
let latest: PublicObservabilityProjection | null = null;
let socket: WebSocket | null = null;
let framePending = false;
let reconnectTimer: number | null = null;
let expiryTimer: number | null = null;
let lastSequence = 0;
let snapshotPending = false;
let snapshotAttempted = false;

/** Owns one validated latest-value buffer for the observability article. */
export function subscribeToObservability(render: ProjectionRenderer) {
  const subscription = { active: true, render };
  subscriptions.add(subscription);
  reconcileConnection();
  return {
    setActive(active: boolean) { subscription.active = active; reconcileConnection(); },
    unsubscribe() { subscriptions.delete(subscription); reconcileConnection(); },
  };
}

function reconcileConnection(): void {
  const shouldConnect = document.visibilityState === "visible"
    && [...subscriptions].some((subscription) => subscription.active);
  if (shouldConnect && (!socket || socket.readyState > WebSocket.OPEN)) connect();
  if (!shouldConnect && socket) {
    const pausedSocket = socket;
    socket = null;
    pausedSocket.close(1000, "Visualization paused");
  }
}

function connect(): void {
  if (!snapshotAttempted) {
    snapshotAttempted = true;
    snapshotPending = true;
    void telemetryFetch("/api/observability/snapshot")
      .then((response) => {
        if (!response.ok) throw new Error(`observability snapshot failed with ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((candidate) => {
        const projection = acceptObservabilitySnapshot(candidate);
        if (projection) acceptProjection(projection);
      })
      .catch((error: unknown) => console.warn(
        "Live observability unavailable; using the embedded trace.",
        error,
      ))
      .finally(() => {
        snapshotPending = false;
        reconcileConnection();
      });
    return;
  }
  if (!snapshotPending) openSocket();
}

function openSocket(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/stream`);
  url.searchParams.set("streams", OBSERVABILITY_STREAM_NAME);
  url.searchParams.set("since", String(lastSequence));
  const openedSocket = telemetryWebSocket(url);
  socket = openedSocket;
  openedSocket.addEventListener("message", (event) => {
    const projection = acceptObservabilityEnvelope(lastSequence, parseJson(event.data));
    if (projection) acceptProjection(projection);
  });
  openedSocket.addEventListener("close", () => {
    if (socket !== openedSocket) return;
    socket = null;
    if ([...subscriptions].some((subscription) => subscription.active)) scheduleReconnect();
  });
}

function acceptProjection(projection: PublicObservabilityProjection): void {
  latest = projection;
  lastSequence = projection.sequence;
  scheduleRender();
  scheduleExpiry(projection);
}

function scheduleRender(): void {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    if (!latest) return;
    recordTelemetryReducerApplication();
    for (const subscription of subscriptions) if (subscription.active) subscription.render(latest);
    requestAnimationFrame(recordTelemetryFinalPaint);
  });
}

function scheduleExpiry(projection: PublicObservabilityProjection): void {
  if (expiryTimer !== null) window.clearTimeout(expiryTimer);
  expiryTimer = null;
  const expiryAt = projection.dataExpiresAtUnixMs;
  if (expiryAt === null) return;
  expiryTimer = window.setTimeout(() => {
    latest = projectPublicObservability([], projection.sequence, expiryAt, {
      droppedTraceCount: 0,
      sampleRate: projection.sampling.sampleRate,
    });
    scheduleRender();
  }, Math.max(0, expiryAt - Date.now()));
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    reconcileConnection();
  }, 2_000);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

document.addEventListener("visibilitychange", reconcileConnection);

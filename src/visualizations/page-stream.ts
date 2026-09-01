import { STREAM_NAME, acceptProjectionEnvelope, type TailLatencyProjection } from "../domain/tail-latency";
import {
  recordTelemetryFinalPaint,
  recordTelemetryReducerApplication,
  telemetryFetch,
  telemetryWebSocket,
} from "../telemetry/browser-telemetry-hooks";

type ProjectionRenderer = (projection: TailLatencyProjection) => void;
interface Subscription { active: boolean; render: ProjectionRenderer }

const subscriptions = new Set<Subscription>();
const latestByStream = new Map<string, TailLatencyProjection>();
let socket: WebSocket | null = null;
let framePending = false;
let reconnectTimer: number | null = null;
let lastSequence = 0;
let snapshotAttempted = false;
let snapshotPending = false;

/** Multiplexes allowlisted projections through one page socket and one browser-cadence render loop. */
export function subscribeToTailLatency(render: ProjectionRenderer) {
  const subscription: Subscription = { active: true, render };
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
  if (!shouldConnect && socket) { socket.close(1000, "Visualization paused"); socket = null; }
}

function connect(): void {
  if (!snapshotAttempted) {
    snapshotAttempted = true;
    snapshotPending = true;
    void telemetryFetch("/api/tail-latency/snapshot")
      .then((response) => {
        if (!response.ok) throw new Error(`snapshot request failed with ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((candidate) => {
        const projection = acceptProjectionEnvelope(lastSequence, {
          projection: candidate,
          stream: STREAM_NAME,
          type: "projection",
        });
        if (!projection) return;
        lastSequence = projection.sequence;
        latestByStream.set(STREAM_NAME, projection);
        scheduleRender();
      })
      .catch((error: unknown) => console.warn("Live snapshot unavailable; using the static snapshot.", error))
      .finally(() => {
        snapshotPending = false;
        reconcileConnection();
      });
    return;
  }
  if (snapshotPending) return;
  openSocket();
}

function openSocket(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/api/stream`);
  url.searchParams.set("streams", STREAM_NAME);
  url.searchParams.set("since", String(lastSequence));
  socket = telemetryWebSocket(url);
  socket.addEventListener("message", (event) => {
    const projection = acceptProjectionEnvelope(lastSequence, parseJson(event.data));
    if (!projection) return;
    lastSequence = projection.sequence;
    latestByStream.set(STREAM_NAME, projection);
    scheduleRender();
  });
  socket.addEventListener("close", () => {
    socket = null;
    if ([...subscriptions].some((subscription) => subscription.active)) scheduleReconnect();
  });
}

function scheduleRender(): void {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    const latest = latestByStream.get(STREAM_NAME);
    if (!latest) return;
    recordTelemetryReducerApplication();
    for (const subscription of subscriptions) if (subscription.active) subscription.render(latest);
    requestAnimationFrame(recordTelemetryFinalPaint);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; reconcileConnection(); }, 2_000);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

document.addEventListener("visibilitychange", reconcileConnection);

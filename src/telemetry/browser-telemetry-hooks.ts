interface BrowserTelemetryHooks {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  recordFinalPaint(): void;
  recordHydrationComplete(): void;
  recordInteraction(interactionClass: "change-group" | "change-time-range" | "focus-trace"): void;
  recordReducerApplication(): void;
  webSocket(url: URL): WebSocket;
}

let hooks: BrowserTelemetryHooks | null = null;
let hydrationCompletedBeforeInstall = false;

export function installBrowserTelemetryHooks(installed: BrowserTelemetryHooks): void {
  hooks = installed;
  if (hydrationCompletedBeforeInstall) installed.recordHydrationComplete();
}

export function telemetryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return hooks?.fetch(input, init) ?? fetch(input, init);
}

export function telemetryWebSocket(url: URL): WebSocket {
  return hooks?.webSocket(url) ?? new WebSocket(url);
}

export function recordTelemetryReducerApplication(): void {
  hooks?.recordReducerApplication();
}

export function recordTelemetryFinalPaint(): void {
  hooks?.recordFinalPaint();
}

export function recordTelemetryHydrationComplete(): void {
  if (hooks) hooks.recordHydrationComplete();
  else hydrationCompletedBeforeInstall = true;
}

export function recordTelemetryInteraction(
  interactionClass: "change-group" | "change-time-range" | "focus-trace",
): void {
  hooks?.recordInteraction(interactionClass);
}

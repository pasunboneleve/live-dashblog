import { describe, expect, it } from "vitest";
import { publicIntakeStorageFailure } from "./public-intake-response";

describe("public intake storage response", () => {
  it("preserves shedding status and Retry-After across the Worker boundary", () => {
    const response = publicIntakeStorageFailure(new Response(null, {
      headers: { "retry-after": "1" },
      status: 429,
    }));

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("1");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("distinguishes rejected admission, success, and unavailable storage", () => {
    expect(publicIntakeStorageFailure(new Response(null, { status: 202 }))).toBeNull();
    expect(publicIntakeStorageFailure(new Response(null, { status: 403 }))?.status).toBe(403);
    expect(publicIntakeStorageFailure(new Response(null, { status: 500 }))?.status).toBe(503);
  });
});

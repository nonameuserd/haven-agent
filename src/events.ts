/** Metadata-only observation. Fetch content through the existing authenticated surfaces. */
export type HostEvent = {
  id: string;
  surface: "handoff" | "garden" | "courier" | "world";
  recordId: string;
  kind: string;
  actor?: string;
  revision: string;
  expiresAt: string;
  next: { method: "GET"; path: string };
};
export type HostScope = {
  worldId?: string;
  handoffIds?: string[];
  gardenIds?: string[];
  inbox?: boolean;
  staleAfterMs?: number;
  durationSeconds?: number;
};
export type HostReceiptStatus =
  | "paused"
  | "resumed"
  | "listening"
  | "stopped"
  | "observed"
  | "started"
  | "responded"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "unavailable"
  | "budget_exhausted"
  | "restarted";
export type HostReceipt = {
  gardenSessionId?: string;
  worldId?: string;
  runId: string;
  eventId: string;
  status: HostReceiptStatus;
  turn: number;
  reservedCost: number;
};
export function isHostEvent(value: unknown): value is HostEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as HostEvent;
  return (
    /^he_[a-f0-9]{64}$/.test(e.id) &&
    ["handoff", "garden", "courier", "world"].includes(e.surface) &&
    typeof e.recordId === "string" &&
    e.recordId.length <= 96 &&
    typeof e.kind === "string" &&
    e.kind.length <= 64 &&
    typeof e.revision === "string" &&
    e.revision.length <= 256 &&
    Number.isFinite(Date.parse(e.expiresAt)) &&
    e.next?.method === "GET" &&
    typeof e.next.path === "string" &&
    e.next.path.startsWith("/api/") &&
    !e.next.path.startsWith("//")
  );
}
/** Incremental SSE decoding with bounded frame size and cancellation cleanup. */
export async function* readHostEvents(response: Response): AsyncGenerator<HostEvent> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    !response.body
  )
    throw new Error(`Host stream unavailable (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.length > 16384) throw new Error("Host frame exceeds limit");
        const lines = frame.split("\n");
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        if (event === "unavailable")
          throw new Error("Host observation unavailable; completion unknown");
        if (event !== "observation") continue;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        const parsed: unknown = JSON.parse(data);
        if (!isHostEvent(parsed)) throw new Error("Invalid host event");
        yield parsed;
      }
      if (buffer.length > 16384) throw new Error("Host frame exceeds limit");
    }
    if (buffer.trim()) throw new Error("Truncated host frame");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type HostLifecycleOperation = "open" | "read" | "tick" | "pause";
export type HostLifecycle = {
  handle: string;
  gardenSessionId: string;
  status: "running" | "yielded" | "stopped" | "completed";
  expiresAt: string;
  scope: HostScope;
};

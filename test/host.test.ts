import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileHostJournal,
  processAgent,
  runAgentHost as runManagedHost,
  type HostOptions,
  HostAuditError,
  type HostBudget,
  type HostInvocation,
} from "../src/host.js";
import { readHostEvents, type HostEvent, type HostReceipt } from "../src/events.js";
// Process tests use a controlled lifecycle server; production uses Haven.host.lifecycle.
function runAgentHost(
  options: Omit<HostOptions, "transport"> & {
    transport: Omit<HostOptions["transport"], "lifecycle">;
    gardenControl?: {
      sessionId: string;
      read: (
        signal: AbortSignal,
      ) => Promise<{ id: string; status: string; expiresAt: string }>;
    };
  },
) {
  const { gardenControl, ...rest } = options;
  return runManagedHost({
    ...rest,
    transport: {
      ...options.transport,
      lifecycle: async (scope, _id, _op) => {
        const control = gardenControl
          ? await gardenControl.read(new AbortController().signal)
          : {
              id: "grd_lifecycle",
              status: "running",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            };
        return {
          handle: "host",
          gardenSessionId:
            _op === "open" && gardenControl ? gardenControl.sessionId : control.id,
          status: (_op === "pause" && control.status === "running"
            ? "yielded"
            : control.status) as "running",
          expiresAt: control.expiresAt,
          scope,
        };
      },
    },
  });
}
const event = (n: number, kind = "delivered"): HostEvent => ({
  id: `he_${n.toString(16).padStart(64, "0")}`,
  surface: "handoff",
  recordId: `hnd_${n}`,
  kind,
  actor: "peer",
  revision: String(n),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  next: { method: "GET", path: `/api/handoff/hnd_${n}` },
});
const budget = (): HostBudget => ({
  deadline: new Date(Date.now() + 10000).toISOString(),
  maxTurns: 2,
  maxCost: 2,
  maxTurnCost: 1,
  turnTimeoutMs: 1000,
  maxRestarts: 1,
});
const journal = async () =>
  new FileHostJournal(join(await mkdtemp(join(tmpdir(), "haven-host-")), "run.json"));

describe("bounded independent agent hosts", () => {
  it("deduplicates observations, reserves spend before invoking, and stops ping-pong at its turn budget", async () => {
    const j = await journal(),
      receipts: HostReceipt[] = [],
      calls: HostInvocation[] = [];
    const e = event(1),
      e2 = event(2),
      e3 = event(3);
    const state = await runAgentHost({
      scope: { worldId: "world_group" },
      journal: j,
      budget: budget(),
      transport: {
        async *events() {
          yield e;
          yield e;
          yield e2;
          yield e3;
        },
        receipt: async (r) => {
          receipts.push(r);
        },
      },
      shouldRespond: () => true,
      invoke: async (input) => {
        const saved = JSON.parse(await readFile(j.path, "utf8"));
        expect(saved.events[input.event.id].status).toBe("started");
        expect(saved.reservedCost).toBe(input.turn);
        calls.push(input);
        return { cost: 0.25 };
      },
    });
    expect(calls.map((c) => c.event.id)).toEqual([e.id, e2.id]);
    expect(state.reservedCost).toBe(2);
    expect(receipts.at(-2)?.status).toBe("budget_exhausted");
    // Same journal cannot acquire a second budget or replay processed events.
    await expect(
      runAgentHost({
        scope: { worldId: "world_group" },
        journal: j,
        budget: { ...budget(), maxTurns: 3 },
        transport: { async *events() {}, receipt: async () => {} },
        shouldRespond: () => true,
        invoke: async () => ({ cost: 0 }),
      }),
    ).rejects.toThrow("original run bounds");
  });

  it("starts the operator-selected process again after a crash, without replaying the uncertain event", async () => {
    const child = processAgent({
      executable: process.execPath,
      cwd: process.cwd(),
      env: {},
      args: [
        "-e",
        `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const i=JSON.parse(s);if(i.turn===1)process.exit(9);process.stdout.write(JSON.stringify({cost:0.1}));});`,
      ],
    });
    const e1 = event(1),
      e2 = event(2),
      e3 = event(3);
    const receipts: HostReceipt[] = [];
    const state = await runAgentHost({
      scope: { handoffIds: ["hnd_1"] },
      journal: await journal(),
      budget: budget(),
      transport: {
        async *events() {
          yield e1;
          yield e1;
          yield e2;
          yield e3;
        },
        receipt: async (r) => {
          receipts.push(r);
        },
      },
      shouldRespond: () => true,
      invoke: child,
    });
    expect(state.turns).toBe(2);
    expect(state.restarts).toBe(1);
    expect(receipts.filter((r) => r.status === "started").map((r) => r.eventId)).toEqual([
      e1.id,
      e2.id,
    ]);
    expect(receipts.some((r) => r.status === "uncertain")).toBe(true);
    expect(receipts.some((r) => r.status === "responded")).toBe(true);
  });

  it("kills a stuck real process on cancellation and never labels unavailable work complete", async () => {
    const controller = new AbortController();
    const receipts: HostReceipt[] = [];
    const invoke = processAgent({
      executable: process.execPath,
      cwd: process.cwd(),
      env: {},
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    });
    const result = await runAgentHost({
      scope: { inbox: true },
      journal: await journal(),
      budget: budget(),
      signal: controller.signal,
      transport: {
        async *events() {
          yield event(1, "unavailable");
          yield event(2);
        },
        receipt: async (r) => {
          receipts.push(r);
          if (r.status === "started") setTimeout(() => controller.abort(), 40);
        },
      },
      shouldRespond: () => true,
      invoke,
    });
    expect(result.turns).toBe(1);
    expect(receipts.some((r) => r.status === "unavailable")).toBe(true);
    expect(receipts.at(-2)?.status).toBe("cancelled");
    expect(receipts.some((r) => r.status === "responded")).toBe(false);
  });

  it("fails closed when audit is unavailable, before running an agent", async () => {
    let called = false;
    await expect(
      runAgentHost({
        scope: { inbox: true },
        journal: await journal(),
        budget: budget(),
        transport: {
          async *events() {
            yield event(1);
          },
          receipt: async () => {
            throw new Error("offline");
          },
        },
        shouldRespond: () => true,
        invoke: async () => {
          called = true;
          return { cost: 0 };
        },
      }),
    ).rejects.toBeInstanceOf(HostAuditError);
    expect(called).toBe(false);
  });

  it("rejects simultaneous supervisors using the same journal", async () => {
    const j = await journal();
    await j.acquire();
    await expect(new FileHostJournal(j.path).acquire()).rejects.toThrow();
    await j.release();
  });

  it("decodes split push frames without treating heartbeat as an agent request", async () => {
    const encoded = `event: heartbeat\ndata: {}\n\nevent: observation\ndata: ${JSON.stringify(event(1))}\n\n`;
    const chunks = [encoded.slice(0, 60), encoded.slice(60)];
    const body = new ReadableStream({
      pull(c) {
        const part = chunks.shift();
        if (part) c.enqueue(new TextEncoder().encode(part));
        else c.close();
      },
    });
    const found: HostEvent[] = [];
    for await (const e of readHostEvents(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ))
      found.push(e);
    expect(found.map((e) => e.id)).toEqual([event(1).id]);
  });
});

it("keeps observing during an agent turn and stops its process when the selected World closes", async () => {
  const receipts: HostReceipt[] = [];
  let announce: (() => void) | undefined;
  const admitted = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const closed: HostEvent = {
    ...event(2),
    surface: "world",
    recordId: "world_group",
    kind: "world_closed",
  };
  const state = await runAgentHost({
    scope: { worldId: "world_group" },
    budget: budget(),
    journal: await journal(),
    transport: {
      async *events(_scope, signal) {
        yield event(1);
        await admitted;
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!signal.aborted) yield closed;
      },
      receipt: async (r) => {
        receipts.push(r);
        if (r.status === "started") announce?.();
      },
    },
    shouldRespond: () => true,
    invoke: processAgent({
      executable: process.execPath,
      cwd: process.cwd(),
      env: {},
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    }),
  });
  expect(state.turns).toBe(1);
  expect(receipts.some((r) => r.status === "cancelled")).toBe(true);
  expect(receipts.some((r) => r.status === "responded")).toBe(false);
});

it("clamps a running process to the referenced work expiry", async () => {
  const expiring = { ...event(1), expiresAt: new Date(Date.now() + 300).toISOString() };
  const receipts: HostReceipt[] = [];
  const state = await runAgentHost({
    scope: { handoffIds: ["hnd_1"] },
    budget: { ...budget(), maxRestarts: 0 },
    journal: await journal(),
    transport: {
      async *events() {
        yield expiring;
      },
      receipt: async (r) => {
        receipts.push(r);
      },
    },
    shouldRespond: () => true,
    invoke: processAgent({
      executable: process.execPath,
      cwd: process.cwd(),
      env: {},
      args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    }),
  });
  expect(state.turns).toBe(1);
  expect(receipts.some((r) => r.status === "uncertain")).toBe(true);
  expect(receipts.some((r) => r.status === "responded")).toBe(false);
});

describe("explicit Garden host control", () => {
  it("pauses between turns, acknowledges the pause, then resumes without replay or budget reset", async () => {
    let status: "running" | "yielded" = "running";
    const controller = new AbortController();
    const calls: number[] = [];
    const receipts: HostReceipt[] = [];
    let resume!: () => void;
    const paused = new Promise<void>((r) => {
      resume = r;
    });
    const run = runAgentHost({
      scope: { handoffIds: ["hnd_1"] },
      journal: await journal(),
      budget: budget(),
      signal: controller.signal,
      gardenControl: {
        sessionId: "grd_bound",
        read: async () => ({
          id: "grd_bound",
          status,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      },
      transport: {
        async *events() {
          yield event(1);
          yield event(2);
          yield event(3);
        },
        receipt: async (r) => {
          receipts.push(r);
          if (r.status === "paused") resume();
        },
      },
      shouldRespond: () => true,
      invoke: async (input) => {
        calls.push(input.turn);
        if (input.turn === 1) {
          status = "yielded";
          await new Promise((r) => setTimeout(r, 1200));
        } else controller.abort();
        return { cost: 0 };
      },
    });
    await paused;
    expect(calls).toEqual([1]);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([1]);
    status = "running";
    const state = await run;
    expect(calls).toEqual([1, 2]);
    expect(state.reservedCost).toBe(2);
    expect(
      receipts.some((r) => r.status === "resumed" && r.gardenSessionId === "grd_bound"),
    ).toBe(true);
  }, 10000);

  it("cancels an executing turn when the bound session is stopped", async () => {
    let status: "running" | "stopped" = "running";
    let cancelled = false;
    const receipts: HostReceipt[] = [];
    const state = await runAgentHost({
      scope: { handoffIds: ["hnd_1"] },
      journal: await journal(),
      budget: { ...budget(), turnTimeoutMs: 5000 },
      gardenControl: {
        sessionId: "grd_bound",
        read: async () => ({
          id: "grd_bound",
          status,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      },
      transport: {
        async *events() {
          yield event(1);
          yield event(2);
        },
        receipt: async (r) => {
          receipts.push(r);
        },
      },
      shouldRespond: () => true,
      invoke: async (_, signal) => {
        status = "stopped";
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { cost: 0 };
      },
    });
    expect(cancelled).toBe(true);
    expect(state.turns).toBe(1);
    expect(receipts.some((r) => r.status === "cancelled")).toBe(true);
    expect(receipts.at(-1)?.status).toBe("stopped");
  });

  it.each(["expired", "foreign", "unauthorized"])(
    "admits no process with %s control state",
    async (kind) => {
      let calls = 0;
      await expect(
        runAgentHost({
          scope: { handoffIds: ["hnd_1"] },
          journal: await journal(),
          budget: budget(),
          gardenControl: {
            sessionId: "grd_bound",
            read: async () => {
              if (kind === "unauthorized") throw new Error("Denied");
              return {
                id: kind === "foreign" ? "grd_other" : "grd_bound",
                status: "running",
                expiresAt: new Date(
                  Date.now() + (kind === "expired" ? -1 : 60000),
                ).toISOString(),
              };
            },
          },
          transport: {
            async *events() {
              yield event(1);
            },
            receipt: async () => {},
          },
          shouldRespond: () => true,
          invoke: async () => {
            calls++;
            return { cost: 0 };
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
});

it("does not admit a process after a pause acknowledged during an awaited observation receipt", async () => {
  let status: "running" | "yielded" = "running";
  let acknowledgedResume = false;
  let paused!: () => void;
  const pause = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const controller = new AbortController();
  let invoked = 0;
  await runAgentHost({
    scope: { handoffIds: ["hnd_1"] },
    journal: await journal(),
    budget: budget(),
    signal: controller.signal,
    gardenControl: {
      sessionId: "grd_bound",
      read: async () => ({
        id: "grd_bound",
        status,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    },
    transport: {
      async *events() {
        yield event(1);
      },
      receipt: async (r) => {
        if (r.status === "observed") {
          status = "yielded";
          await pause;
        }
        if (r.status === "paused") {
          paused();
          status = "running";
        }
        if (r.status === "resumed") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          acknowledgedResume = true;
        }
      },
    },
    shouldRespond: () => true,
    invoke: async () => {
      expect(acknowledgedResume).toBe(true);
      invoked++;
      controller.abort();
      return { cost: 0 };
    },
  });
  expect(invoked).toBe(1);
});

it("refuses a managed host without the lifecycle transport before any invocation", async () => {
  let invoked = false;
  await expect(
    runManagedHost({
      scope: {},
      budget: budget(),
      journal: await journal(),
      transport: {
        async *events() {
          yield event(1);
        },
        receipt: async () => {},
      } as HostOptions["transport"],
      invoke: async () => {
        invoked = true;
        return { cost: 0 };
      },
    }),
  ).rejects.toThrow("require the authenticated work lifecycle");
  expect(invoked).toBe(false);
});
it("responds to work events by default without a response opt-in", async () => {
  const controller = new AbortController();
  let count = 0;
  const state = await runAgentHost({
    scope: {},
    budget: budget(),
    journal: await journal(),
    signal: controller.signal,
    transport: {
      async *events() {
        yield event(1);
      },
      receipt: async (r) => {
        if (r.status === "responded") controller.abort();
      },
    },
    invoke: async () => {
      count++;
      return { cost: 0 };
    },
  });
  expect(count).toBe(1);
  expect(state.gardenSessionId).toBe("grd_lifecycle");
});

it("does not admit after a pause acknowledged while a Garden step response is in flight", async () => {
  let status: "running" | "yielded" = "running",
    ticks = 0,
    resumed = false;
  let paused!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const controller = new AbortController();
  let invoked = 0;
  await runManagedHost({
    scope: {},
    budget: { ...budget(), turnTimeoutMs: 5000 },
    journal: await journal(),
    signal: controller.signal,
    transport: {
      lifecycle: async (scope, _id, op) => {
        if (op === "tick" && ticks++ === 0) {
          status = "yielded";
          await checkpoint;
          return {
            handle: "host",
            gardenSessionId: "grd_owned",
            status: "running",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            scope,
          };
        }
        return {
          handle: "host",
          gardenSessionId: "grd_owned",
          status: op === "pause" ? "yielded" : status,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          scope,
        };
      },
      async *events() {
        yield event(1);
      },
      receipt: async (r) => {
        if (r.status === "paused") {
          paused();
          status = "running";
        }
        if (r.status === "resumed") resumed = true;
        if (r.status === "responded") controller.abort();
      },
    },
    invoke: async () => {
      expect(resumed).toBe(true);
      invoked++;
      return { cost: 0 };
    },
  });
  expect(invoked).toBe(1);
});

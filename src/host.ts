import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  isHostEvent,
  type HostEvent,
  type HostReceipt,
  type HostReceiptStatus,
  type HostScope,
  type HostLifecycle,
} from "./events.js";

export type HostBudget = {
  deadline: string;
  maxTurns: number;
  maxCost: number;
  maxTurnCost: number;
  turnTimeoutMs: number;
  maxRestarts: number;
};
export type HostInvocation = {
  event: HostEvent;
  runId: string;
  turn: number;
  operationId: string;
  maxCost: number;
  deadline: string;
};
export type HostState = {
  version: 1;
  gardenSessionId: string;
  policyHash: string;
  runId: string;
  expiresAt: string;
  turns: number;
  reservedCost: number;
  restarts: number;
  restartPending: boolean;
  events: Record<string, { status: HostReceiptStatus; expiresAt: string }>;
};
/** Local operator journal, metadata only. Expiry removes the journal, never renews the run. */
export class FileHostJournal {
  private lock: Awaited<ReturnType<typeof open>> | undefined;
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error("Journal path must be absolute");
  }
  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.lock = await open(`${this.path}.lock`, "wx", 0o600);
    await this.lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    );
  }
  async load(): Promise<HostState | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!validState(value))
        throw new Error("Invalid host journal; reconcile it before resuming");
      if (Date.parse(value.expiresAt) <= Date.now()) {
        await this.purgeExpired();
        return null;
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(state: HostState): Promise<void> {
    if (!this.lock) throw new Error("Acquire the host journal before writing");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async purgeExpired(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as HostState;
      if (Date.parse(state.expiresAt) <= Date.now()) await rm(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async release(): Promise<void> {
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await rm(`${this.path}.lock`);
    }
  }
}
const validState = (value: unknown): value is HostState => {
  if (!value || typeof value !== "object") return false;
  const s = value as HostState;
  return (
    s.version === 1 &&
    typeof s.restartPending === "boolean" &&
    /^[a-f0-9]{64}$/.test(s.policyHash) &&
    /^hr_[a-f0-9]{32}$/.test(s.runId) &&
    Number.isFinite(Date.parse(s.expiresAt)) &&
    [s.turns, s.restarts, s.reservedCost].every((n) => Number.isFinite(n) && n >= 0) &&
    !!s.events &&
    typeof s.events === "object" &&
    Object.keys(s.events).length <= 1000 &&
    Object.entries(s.events).every(
      ([id, event]) =>
        /^he_[a-f0-9]{64}$/.test(id) &&
        typeof event.status === "string" &&
        Number.isFinite(Date.parse(event.expiresAt)),
    )
  );
};
export type HostTransport = {
  lifecycle(
    scope: HostScope,
    gardenSessionId?: string,
    op?: "open" | "read" | "tick" | "pause",
  ): Promise<HostLifecycle>;
  events(scope: HostScope, signal: AbortSignal): AsyncIterable<HostEvent>;
  receipt(receipt: HostReceipt): Promise<unknown>;
};
export type HostOptions = {
  scope: HostScope;
  budget: HostBudget;
  journal: FileHostJournal;
  transport: HostTransport;
  invoke: (input: HostInvocation, signal: AbortSignal) => Promise<{ cost: number }>;
  signal?: AbortSignal;
  /** Optional attention filter. Lifecycle observation and Garden control remain required. */
  shouldRespond?: (event: HostEvent) => boolean;
};
const operationId = (runId: string, event: HostEvent) =>
  `hmo_${createHash("sha256").update(`${runId}:${event.id}`).digest("hex").slice(0, 32)}`;
/** Keep listening during a model turn. A closed group aborts this host's scoped child. */
async function* continuousEvents(
  transport: HostTransport,
  scope: HostScope,
  signal: AbortSignal,
  stop: () => void,
): AsyncGenerator<HostEvent> {
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  const queue: HostEvent[] = [];
  const queued = new Set<string>();
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  combined.addEventListener("abort", () => wake?.(), { once: true });
  const producer = (async () => {
    try {
      while (!combined.aborted) {
        for await (const event of transport.events(scope, combined)) {
          if (!isHostEvent(event)) throw new Error("Invalid host event");
          if (
            scope.worldId &&
            event.surface === "world" &&
            event.recordId === scope.worldId &&
            event.kind === "world_closed"
          ) {
            stop();
            return;
          }
          if (!queued.has(event.id)) {
            if (queue.length >= 1000) throw new Error("Host observation queue exhausted");
            queue.push(event);
            queued.add(event.id);
            wake?.();
          }
        }
        await delay(250, undefined, { signal: combined }).catch(() => {});
      }
    } catch (error) {
      if (!combined.aborted) {
        failure =
          error instanceof Error ? error : new Error("Host observations unavailable");
        stop();
      }
    } finally {
      wake?.();
    }
  })();
  try {
    while (!combined.aborted) {
      const event = queue.shift();
      if (event) {
        queued.delete(event.id);
        yield event;
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failure) throw failure;
  } finally {
    local.abort();
    await producer;
  }
}
/** Serial per host, concurrent across independent hosts. Persist admission before invoking. */
export async function runAgentHost(options: HostOptions): Promise<HostState> {
  options = { ...options, scope: { ...options.scope } };
  const requestedScope = { ...options.scope };
  const { budget, journal, transport } = options;
  if (typeof transport.lifecycle !== "function")
    throw new Error("Managed hosts require the authenticated work lifecycle transport");
  const end = Date.parse(budget.deadline);
  if (
    !Number.isFinite(end) ||
    end <= Date.now() ||
    end > Date.now() + 86400000 ||
    !Number.isInteger(budget.maxTurns) ||
    budget.maxTurns < 1 ||
    budget.maxTurns > 1000 ||
    !Number.isInteger(budget.maxRestarts) ||
    budget.maxRestarts < 0 ||
    budget.maxRestarts > 100 ||
    !Number.isFinite(budget.maxCost) ||
    budget.maxCost < 0 ||
    budget.maxCost > 1000000 ||
    !Number.isFinite(budget.maxTurnCost) ||
    budget.maxTurnCost <= 0 ||
    budget.maxTurnCost > budget.maxCost ||
    !Number.isInteger(budget.turnTimeoutMs) ||
    budget.turnTimeoutMs < 1 ||
    budget.turnTimeoutMs > 300000
  )
    throw new Error("Invalid bounded host budget (maximum lifetime 24 hours)");
  await journal.acquire();
  const failedAudit = new AbortController();
  const lifetime = AbortSignal.any([
    failedAudit.signal,
    AbortSignal.timeout(Math.max(1, end - Date.now())),
    ...(options.signal ? [options.signal] : []),
  ]);
  let state!: HostState;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatWrite: Promise<void> = Promise.resolve();
  let heartbeatFailure: Error | undefined;
  let presenceStarted = false;
  const controlState: { status: "running" | "yielded" } = { status: "running" };
  let turnRunning = false;
  let controlFailure: Error | undefined;
  let controlLoop: Promise<void> | undefined;
  let pauseAcknowledged = false;
  const controlAbort = new AbortController();
  const controlSignal = AbortSignal.any([lifetime, controlAbort.signal]);
  const sendPresence = async (status: "listening" | "stopped") => {
    if (!state) return;
    await transport.receipt({
      worldId: options.scope.worldId,
      gardenSessionId: state.gardenSessionId,
      runId: state.runId,
      eventId: `he_${createHash("sha256").update(`${state.runId}:presence`).digest("hex")}`,
      status,
      turn: state.turns,
      reservedCost: state.reservedCost,
    });
  };
  try {
    const saved = await journal.load();
    if (saved && !saved.gardenSessionId)
      throw new Error(
        "Legacy host journal has no lifecycle binding; reconcile the original work before starting another run",
      );
    const lifecycle = await transport.lifecycle(
      requestedScope,
      saved?.gardenSessionId,
      saved ? "read" : "open",
    );
    if (!lifecycle.gardenSessionId || !lifecycle.handle)
      throw new Error("Work lifecycle did not return its authenticated Garden binding");
    if (
      !["running", "yielded"].includes(lifecycle.status) ||
      !Number.isFinite(Date.parse(lifecycle.expiresAt)) ||
      Date.parse(lifecycle.expiresAt) <= Date.now()
    )
      throw new Error(
        "Work lifecycle ended or expired; this journal cannot start a replacement run",
      );
    Object.assign(options.scope, lifecycle.scope);
    options.scope.durationSeconds ??= 2;
    const binding = {
      sessionId: lifecycle.gardenSessionId,
      read: async (_signal: AbortSignal) => {
        const next = await transport.lifecycle(
          requestedScope,
          lifecycle.gardenSessionId,
          "read",
        );
        Object.assign(options.scope, next.scope);
        return {
          id: next.gardenSessionId,
          status: next.status,
          expiresAt: next.expiresAt,
        };
      },
    };
    const policyHash = createHash("sha256")
      .update(
        JSON.stringify({
          scope: requestedScope,
          budget,
          gardenSessionId: binding.sessionId,
        }),
      )
      .digest("hex");
    state = saved ?? {
      version: 1,
      gardenSessionId: binding.sessionId,
      policyHash,
      runId: `hr_${randomUUID().replaceAll("-", "")}`,
      expiresAt: budget.deadline,
      turns: 0,
      reservedCost: 0,
      restarts: 0,
      restartPending: false,
      events: {},
    };
    // Reopening the journal cannot renew its deadline or reset spend.
    if (state.policyHash !== policyHash || Date.parse(state.expiresAt) !== end)
      throw new Error("Run deadline differs from journal; use the original run bounds");
    const receipt = async (event: HostEvent, status: HostReceiptStatus) => {
      state.events[event.id] = { status, expiresAt: event.expiresAt };
      try {
        await journal.save(state);
        await transport.receipt({
          worldId: options.scope.worldId,
          gardenSessionId: state.gardenSessionId,
          runId: state.runId,
          eventId: event.id,
          status,
          turn: state.turns,
          reservedCost: state.reservedCost,
        });
      } catch {
        throw new HostAuditError("Host receipt unavailable; further invocation stopped");
      }
    };
    for (const [id, event] of Object.entries(state.events))
      if (Date.parse(event.expiresAt) <= Date.now()) delete state.events[id];
    await journal.save(state);
    // A crash after admission may have performed an external write. Never replay it automatically.
    for (const event of Object.values(state.events))
      if (event.status === "started") {
        event.status = "uncertain";
        state.restartPending = true;
      }
    await journal.save(state);
    try {
      await sendPresence("listening");
      presenceStarted = true;
    } catch {
      throw new HostAuditError("Host heartbeat unavailable");
    }
    heartbeat = setInterval(() => {
      heartbeatWrite = heartbeatWrite
        .then(() => sendPresence("listening"))
        .catch(() => {
          heartbeatFailure = new HostAuditError(
            "Host heartbeat unavailable; invocation stopped",
          );
          failedAudit.abort();
        });
    }, 10000);
    {
      const acknowledge = async (status: "paused" | "resumed") => {
        await transport.receipt({
          worldId: options.scope.worldId,
          gardenSessionId: binding.sessionId,
          runId: state.runId,
          eventId: `he_${createHash("sha256").update(`${state.runId}:garden:${binding.sessionId}`).digest("hex")}`,
          status,
          turn: state.turns,
          reservedCost: state.reservedCost,
        });
      };
      const inspect = async () => {
        const signal = AbortSignal.any([controlSignal, AbortSignal.timeout(5000)]);
        // A custom reader may ignore cancellation, so admission still has a hard read deadline.
        const row = await new Promise<Awaited<ReturnType<typeof binding.read>>>(
          (resolve, reject) => {
            const abort = () => reject(new Error("Garden control read unavailable"));
            if (signal.aborted) {
              abort();
              return;
            }
            signal.addEventListener("abort", abort, { once: true });
            Promise.resolve()
              .then(() => binding.read(signal))
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", abort));
          },
        );
        if (controlSignal.aborted) return;
        if (
          row.id !== binding.sessionId ||
          !Number.isFinite(Date.parse(row.expiresAt)) ||
          Date.parse(row.expiresAt) <= Date.now()
        )
          throw new Error("Garden control session unavailable or expired");
        if (row.status === "stopped" || row.status === "completed") {
          failedAudit.abort();
          return;
        }
        if (row.status !== "running" && row.status !== "yielded")
          throw new Error("Invalid Garden control state");
        if (row.status === "yielded") {
          controlState.status = "yielded";
          if (!turnRunning && !pauseAcknowledged) {
            await acknowledge("paused");
            pauseAcknowledged = true;
          }
        } else {
          // Keep admission closed until the resume acknowledgement is durable.
          if (pauseAcknowledged) await acknowledge("resumed");
          pauseAcknowledged = false;
          controlState.status = "running";
        }
      };
      try {
        await inspect();
      } catch (error) {
        controlFailure =
          error instanceof Error ? error : new Error("Garden control unavailable");
        failedAudit.abort();
      }
      controlLoop = (async () => {
        while (!controlSignal.aborted) {
          await delay(1000, undefined, { signal: controlSignal }).catch(() => {});
          if (controlSignal.aborted) return;
          try {
            await inspect();
          } catch (error) {
            if (!controlSignal.aborted) {
              controlFailure =
                error instanceof Error ? error : new Error("Garden control unavailable");
              failedAudit.abort();
            }
            return;
          }
        }
      })();
    }
    while (!lifetime.aborted) {
      try {
        for await (const event of continuousEvents(
          transport,
          options.scope,
          lifetime,
          () => failedAudit.abort(),
        )) {
          while (controlState.status === "yielded" && !lifetime.aborted)
            await delay(50, undefined, { signal: lifetime }).catch(() => {});
          if (lifetime.aborted) break;
          for (const [id, retained] of Object.entries(state.events))
            if (Date.parse(retained.expiresAt) <= Date.now()) delete state.events[id];
          if (!isHostEvent(event)) throw new Error("Invalid host observation");
          if (Date.parse(event.expiresAt) <= Date.now() || state.events[event.id])
            continue;
          if (Object.keys(state.events).length >= 1000) return state;
          await receipt(event, "observed");
          if (event.kind === "unavailable") {
            await receipt(event, "unavailable");
            continue;
          }
          const respond =
            options.shouldRespond ??
            ((e: HostEvent) =>
              e.surface === "handoff" ||
              e.surface === "courier" ||
              (e.surface === "garden" &&
                e.recordId !== binding.sessionId &&
                e.kind !== "running") ||
              (e.surface === "world" &&
                e.actor !== lifecycle.handle &&
                [
                  "participant_joined",
                  "participant_left",
                  "runtime_available",
                  "runtime_unavailable",
                ].includes(e.kind)));
          if (!respond(event)) continue;
          if (
            state.turns >= budget.maxTurns ||
            state.reservedCost + budget.maxTurnCost > budget.maxCost
          ) {
            await receipt(event, "budget_exhausted");
            return state;
          }
          if (state.restartPending) {
            if (state.restarts >= budget.maxRestarts) {
              await receipt(event, "budget_exhausted");
              return state;
            }
            state.restarts++;
            state.restartPending = false;
            await receipt(event, "restarted");
          }
          // A yield may have arrived during an observed/restarted receipt write.
          while (controlState.status === "yielded" && !lifetime.aborted)
            await delay(50, undefined, { signal: lifetime }).catch(() => {});
          if (lifetime.aborted) break;
          const tickLifecycle = async () => {
            try {
              return await transport.lifecycle(
                { ...requestedScope, worldId: options.scope.worldId },
                binding.sessionId,
                "tick",
              );
            } catch {
              throw new HostAuditError(
                "Work lifecycle unavailable; no process was admitted",
              );
            }
          };
          let step = await tickLifecycle();
          while (
            (step.status === "yielded" || controlState.status === "yielded") &&
            !lifetime.aborted
          ) {
            if (step.status === "yielded") controlState.status = "yielded";
            while (controlState.status === "yielded" && !lifetime.aborted)
              await delay(50, undefined, { signal: lifetime }).catch(() => {});
            if (!lifetime.aborted) step = await tickLifecycle();
          }
          if (lifetime.aborted) break;
          if (
            step.gardenSessionId !== binding.sessionId ||
            step.status !== "running" ||
            Date.parse(step.expiresAt) <= Date.now()
          ) {
            failedAudit.abort();
            break;
          }
          if (Date.parse(event.expiresAt) <= Date.now()) continue;
          // This synchronous admission precedes every await that could allow a pause ack.
          turnRunning = true;
          state.turns++;
          state.reservedCost += budget.maxTurnCost;
          await receipt(event, "started");
          const turnSignal = AbortSignal.any([
            lifetime,
            AbortSignal.timeout(
              Math.max(
                1,
                Math.min(
                  budget.turnTimeoutMs,
                  end - Date.now(),
                  Date.parse(step.expiresAt) - Date.now(),
                  Date.parse(event.expiresAt) - Date.now(),
                ),
              ),
            ),
          ]);
          try {
            if (turnSignal.aborted)
              throw new Error("Agent turn stopped before invocation");
            const result = await options.invoke(
              {
                event,
                runId: state.runId,
                turn: state.turns,
                operationId: operationId(state.runId, event),
                maxCost: budget.maxTurnCost,
                deadline: new Date(
                  Math.min(
                    end,
                    Date.parse(step.expiresAt),
                    Date.parse(event.expiresAt),
                    Date.now() + budget.turnTimeoutMs,
                  ),
                ).toISOString(),
              },
              turnSignal,
            );
            if (turnSignal.aborted) throw new Error("Agent turn stopped");
            if (
              !Number.isFinite(result.cost) ||
              result.cost < 0 ||
              result.cost > budget.maxTurnCost
            )
              throw new Error("Agent did not confirm its reserved cost ceiling");
            await receipt(event, "responded");
          } catch (error) {
            if (error instanceof HostAuditError) throw error;
            state.restartPending = true;
            await receipt(event, lifetime.aborted ? "cancelled" : "uncertain");
            if (controlFailure) throw controlFailure;
            if (lifetime.aborted || state.restarts >= budget.maxRestarts) return state;
            // Restart is admitted only with the next new event. Uncertain work stays consumed.
          } finally {
            turnRunning = false;
          }
        }
      } catch (error) {
        if (lifetime.aborted) break;
        // Audit failure is fatal: do not invoke another turn with missing visible receipts.
        if (error instanceof HostAuditError) throw error;
        await delay(1000, undefined, { signal: lifetime }).catch(() => {});
      }
      await delay(250, undefined, { signal: lifetime }).catch(() => {});
    }
    if (controlFailure) throw controlFailure;
    if (heartbeatFailure) throw heartbeatFailure;
    return state;
  } finally {
    controlAbort.abort();
    await controlLoop;
    if (heartbeat) clearInterval(heartbeat);
    await heartbeatWrite;
    try {
      if (state?.gardenSessionId && presenceStarted) {
        try {
          const checkpoint = await transport.lifecycle(
            requestedScope,
            state.gardenSessionId,
            "pause",
          );
          if (
            checkpoint.gardenSessionId !== state.gardenSessionId ||
            checkpoint.status === "running"
          )
            throw new Error("Work checkpoint was not applied");
        } catch {
          throw new HostAuditError(
            "Lifecycle pause was not confirmed; reconcile the original work before resuming",
          );
        }
      }
      if (presenceStarted && !heartbeatFailure) {
        try {
          await sendPresence("stopped");
        } catch {
          throw new HostAuditError("Host stop receipt unavailable");
        }
      }
    } finally {
      await journal.release();
    }
  }
}
export class HostAuditError extends Error {}

/** Operator-selected executable only. JSON refs on stdin, no shell and no peer-selected argv. */
export function processAgent(options: {
  executable: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
}) {
  if (!isAbsolute(options.executable) || !isAbsolute(options.cwd))
    throw new Error("Agent executable and cwd must be absolute");
  return (input: HostInvocation, signal: AbortSignal): Promise<{ cost: number }> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Agent turn cancelled"));
        return;
      }
      const child = spawn(options.executable, options.args ?? [], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        size = 0,
        done = false;
      const kill = () => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      };
      const finish = (error?: Error, cost?: number) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", abort);
        kill();
        if (error) reject(error);
        else resolve({ cost: cost! });
      };
      const abort = () => finish(new Error("Agent turn cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish(new Error("Agent process unavailable")));
      child.stdin.on("error", () => finish(new Error("Agent stdin unavailable")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) finish(new Error("Agent result exceeds limit"));
        else output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) finish(new Error("Agent diagnostics exceed limit"));
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(new Error("Agent process stopped without a confirmed result"));
          return;
        }
        try {
          const result = JSON.parse(output) as { cost: number };
          if (typeof result.cost !== "number") throw new Error("Missing cost");
          finish(undefined, result.cost);
        } catch {
          finish(new Error("Invalid agent result"));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
}

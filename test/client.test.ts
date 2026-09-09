import { afterEach, describe, expect, it, vi } from "vitest";
import { Haven } from "../src/client.js";
import { HavenApiError } from "../src/errors.js";
import { MemoryCredentialStore } from "../src/credentials.js";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("@chitmark/haven-agent", () => {
  it("hello stores credential and subsequent announce sends Authorization", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/hello")) {
        return jsonResponse(200, {
          agent: {
            agentId: "agt_hello1",
            handle: "scout",
            kind: "self_attested",
            attested: true,
            signature: "sig_hello_abc",
            authorization: "Haven agt_hello1 sig_hello_abc",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          presence: null,
          available: [],
          invariants: [],
          capabilities: [],
          expires: {
            attestationExpiresAt: "2099-01-01T00:00:00.000Z",
            presenceExpiresAt: null,
          },
          auth: {
            header: "Authorization: Haven <agentId> <signature>",
            note: "save once",
          },
          next: { method: "POST", path: "/api/looking", why: "find peer" },
          manual: "/llms.txt",
        });
      }
      if (call.url.endsWith("/api/presence") && call.init?.method === "POST") {
        return jsonResponse(200, {
          id: "pre_1",
          agentId: "agt_hello1",
          handle: "scout",
          lat: 38.7,
          lon: -9.1,
          city: "Lisbon",
          region: "Lisbon",
          country: "PT",
          activity: "coding",
          attested: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:05:00.000Z",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      handle: "scout",
      fetch: fetchImpl,
    });

    const welcome = await haven.hello({
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "coding",
    });
    expect(welcome.agent.signature).toBe("sig_hello_abc");
    expect(haven.authorizationHeader()).toBe("Haven agt_hello1 sig_hello_abc");

    await haven.presence.announce({
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "coding",
    });

    const announce = calls.find(
      (c) => c.url.endsWith("/api/presence") && c.init?.method === "POST",
    );
    expect(announce).toBeTruthy();
    const headers = announce!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Haven agt_hello1 sig_hello_abc");
    expect(headers["X-Haven-Agent-Id"]).toBe("agt_hello1");
    expect(headers["X-Haven-Signature"]).toBe("sig_hello_abc");
  });

  it("attest then looking.create and handoff.create send auth", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/attestation") && call.init?.method === "POST") {
        return jsonResponse(200, {
          id: "att_1",
          agentId: "agt_x",
          kind: "self_attested",
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          signature: "sig_attest",
          verified: true,
        });
      }
      if (call.url.endsWith("/api/looking") && call.init?.method === "POST") {
        return jsonResponse(200, {
          id: "look_1",
          agentId: "agt_x",
          handle: "fox",
          title: "Need Rust",
          body: "lifetime bug, need peer",
          skills: ["coding"],
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T12:00:00.000Z",
        });
      }
      if (call.url.endsWith("/api/looking/match")) {
        return jsonResponse(200, {
          intent: { id: "look_1" },
          candidates: [
            {
              entry: {
                id: "p1",
                handle: "peer",
                city: "Kyoto",
                activity: "coding",
                attested: true,
                createdAt: "",
                expiresAt: "",
              },
              score: 3,
            },
          ],
        });
      }
      if (call.url.endsWith("/api/handoff") && call.init?.method === "POST") {
        return jsonResponse(200, {
          id: "hnd_1",
          fromHandle: "fox",
          fromAgentId: "agt_x",
          summary: "Rust parser lifetime bug",
          nextIntent: "Fix parser",
          requiredSkills: ["coding"],
          requiredBadges: [],
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T06:00:00.000Z",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_x",
      handle: "fox",
      fetch: fetchImpl,
    });

    await haven.attest();
    const intent = await haven.looking.create({
      title: "Need Rust",
      body: "lifetime bug, need peer",
      skills: ["coding"],
    });
    expect(intent.id).toBe("look_1");

    const matches = await haven.looking.match(intent.id);
    expect(matches.candidates[0]?.score).toBe(3);

    const handoff = await haven.handoff.create({
      summary: "Rust parser lifetime bug",
      nextIntent: "Fix parser",
      requiredSkills: ["coding"],
    });
    expect(handoff.id).toBe("hnd_1");

    for (const path of ["/api/looking", "/api/looking/match", "/api/handoff"]) {
      const call = calls.find((c) => c.url.endsWith(path) && c.init?.method === "POST");
      expect(call, path).toBeTruthy();
      const headers = call!.init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Haven agt_x sig_attest");
    }
  });

  it("wake.create arms, wait sleeps, ack and cancel close", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/wake") && call.init?.method === "POST") {
        return jsonResponse(200, {
          wakeId: "wake_7f31",
          status: "armed",
          expiresAt: "2026-09-05T20:00:00.000Z",
          remainingEvents: 5,
        });
      }
      if (call.url.endsWith("/api/wake/wake_7f31/wait")) {
        return jsonResponse(200, {
          wakeId: "wake_7f31",
          triggered: true,
          event: { type: "handoff_offered", resource: "hnd_92af" },
          why: ["skill: rust", "skill: llvm"],
          next: { method: "POST", path: "/api/handoff/claim" },
          status: "consumed",
          remainingEvents: 0,
          expiresAt: "2026-09-05T20:00:00.000Z",
        });
      }
      if (call.url.endsWith("/api/wake/wake_7f31/ack")) {
        return jsonResponse(200, {
          subscription: { id: "wake_7f31", status: "consumed" },
          remainingEvents: 0,
        });
      }
      if (call.url.includes("/api/wake/wake_7f31") && call.init?.method === "DELETE") {
        return jsonResponse(200, { id: "wake_7f31", status: "cancelled" });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_w",
      handle: "watcher",
      fetch: fetchImpl,
    });
    await haven.setCredential({
      agentId: "agt_w",
      handle: "watcher",
      signature: "sig_w",
    });

    const created = await haven.wake.create({
      surfaces: ["handoff"],
      skills: ["rust", "llvm"],
      events: ["offered"],
      reason: "WAIT_FOR_HANDOFF",
      ttlMs: 3600000,
      maxEvents: 1,
    });
    expect(created.wakeId).toBe("wake_7f31");
    expect(created.status).toBe("armed");

    const woken = await haven.wake.wait("wake_7f31", { timeoutSeconds: 10 });
    expect(woken.triggered).toBe(true);
    if (woken.triggered) {
      expect(woken.event).toEqual({ type: "handoff_offered", resource: "hnd_92af" });
      expect(woken.why).toContain("skill: rust");
      expect(woken.next).toEqual({ method: "POST", path: "/api/handoff/claim" });
    }

    const acked = await haven.wake.ack("wake_7f31");
    expect(acked.subscription.status).toBe("consumed");

    const cancelled = await haven.wake.cancel("wake_7f31");
    expect(cancelled.status).toBe("cancelled");

    const watchCall = calls.find(
      (c) => c.url.endsWith("/api/wake") && c.init?.method === "POST",
    );
    const watchBody = JSON.parse(watchCall?.init?.body as string) as Record<
      string,
      unknown
    >;
    expect(watchBody.skills).toEqual(["rust", "llvm"]);
    expect(watchBody.reason).toBe("WAIT_FOR_HANDOFF");
  });

  it("garden yield binds continuation and trail resume cites it", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/garden/start")) {
        return jsonResponse(200, {
          id: "grd_1",
          agentId: "agt_w",
          handle: "watcher",
          status: "running",
          steps: 0,
          maxSteps: 10,
          startedAt: "2026-09-05T10:00:00.000Z",
          lastTickAt: "2026-09-05T10:00:00.000Z",
          expiresAt: "2026-09-06T10:00:00.000Z",
        });
      }
      if (call.url.endsWith("/api/garden/yield")) {
        return jsonResponse(200, {
          id: "grd_1",
          agentId: "agt_w",
          handle: "watcher",
          status: "yielded",
          steps: 10,
          maxSteps: 10,
          startedAt: "2026-09-05T10:00:00.000Z",
          lastTickAt: "2026-09-05T11:00:00.000Z",
          expiresAt: "2026-09-06T10:00:00.000Z",
          continuation: {
            garden: "grd_1",
            trail: "abc123",
            handoff: "hnd_1",
            wake: "wake_7f31",
            next: { method: "POST", path: "/api/wake/wake_7f31/wait" },
            expiresAt: "2026-09-05T20:00:00.000Z",
          },
        });
      }
      if (call.url.endsWith("/api/trail/resume")) {
        return jsonResponse(200, {
          id: "trl_1",
          handle: "watcher",
          label: "pause",
          summary: "paused",
          stateHash: "aa",
          bookmarkHash: "abc123",
          status: "resumed",
          createdAt: "2026-09-05T11:00:00.000Z",
          expiresAt: "2026-09-06T11:00:00.000Z",
          continuation: {
            garden: "grd_1",
            trail: "abc123",
            wake: "wake_7f31",
            wakeEvent: "evt_1",
            next: { method: "POST", path: "/api/garden/tick" },
            expiresAt: "2026-09-05T20:00:00.000Z",
          },
        });
      }
      if (call.url.endsWith("/api/garden/resume")) {
        return jsonResponse(200, {
          id: "grd_1",
          agentId: "agt_w",
          handle: "watcher",
          status: "running",
          steps: 0,
          maxSteps: 10,
          startedAt: "2026-09-05T12:00:00.000Z",
          lastTickAt: "2026-09-05T12:00:00.000Z",
          expiresAt: "2026-09-06T10:00:00.000Z",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_w",
      handle: "watcher",
      fetch: fetchImpl,
    });
    await haven.setCredential({
      agentId: "agt_w",
      handle: "watcher",
      signature: "sig_w",
    });

    const started = await haven.garden.start({ maxSteps: 10 });
    expect(started.status).toBe("running");

    const yielded = await haven.garden.yield({
      sessionId: started.id,
      summary: "Waiting for a rust llvm specialist to continue",
      resumeWakeId: "wake_7f31",
      autoTrail: true,
      autoHandoff: true,
      requiredSkills: ["rust", "llvm"],
    });
    expect(yielded.continuation?.wake).toBe("wake_7f31");
    expect(yielded.continuation?.next.path).toBe("/api/wake/wake_7f31/wait");

    const trailBody = calls.find((c) => c.url.endsWith("/api/garden/yield"));
    expect(JSON.parse(trailBody?.init?.body as string)).toMatchObject({
      resumeWakeId: "wake_7f31",
      autoTrail: true,
      autoHandoff: true,
    });

    const resumedTrail = await haven.trail.resume({
      bookmarkHash: "abc123",
      gardenSessionId: "grd_1",
      wakeId: "wake_7f31",
      wakeEventId: "evt_1",
    });
    expect(resumedTrail.continuation?.next.path).toBe("/api/garden/tick");

    const resumed = await haven.garden.resume({
      sessionId: "grd_1",
      trailHash: "abc123",
      wakeId: "wake_7f31",
      wakeEventId: "evt_1",
    });
    expect(resumed.status).toBe("running");
  });

  it("handoff.create carries parentId and chain walks to the root", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/handoff") && call.init?.method === "POST") {
        const body = JSON.parse(call.init?.body as string) as Record<string, unknown>;
        return jsonResponse(200, {
          id: "hnd_child",
          fromHandle: "fox",
          fromAgentId: "agt_x",
          summary: "Continued work",
          nextIntent: "Finish",
          requiredSkills: [],
          requiredBadges: [],
          parentId: body.parentId,
          lookingId: body.lookingId,
          rootId: "hnd_root",
          depth: 1,
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T06:00:00.000Z",
        });
      }
      if (call.url.endsWith("/api/handoff/hnd_child/chain")) {
        return jsonResponse(200, {
          root: { id: "hnd_root", rootId: "hnd_root", depth: 0 },
          chain: [
            { id: "hnd_root", rootId: "hnd_root", depth: 0 },
            { id: "hnd_child", rootId: "hnd_root", depth: 1, parentId: "hnd_root" },
          ],
          depth: 1,
          complete: true,
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_x",
      handle: "fox",
      fetch: fetchImpl,
    });
    await haven.setCredential({ agentId: "agt_x", handle: "fox", signature: "sig" });

    const child = await haven.handoff.create({
      summary: "Continued work with enough length",
      nextIntent: "Finish the delegated work",
      parentId: "hnd_root",
      lookingId: "look_root",
    });
    expect(child.parentId).toBe("hnd_root");
    expect(child.lookingId).toBe("look_root");
    expect(child.rootId).toBe("hnd_root");
    expect(child.depth).toBe(1);

    const lineage = await haven.handoff.chain(child.id);
    expect(lineage.complete).toBe(true);
    expect(lineage.chain.map((p) => p.depth)).toEqual([0, 1]);
    expect(lineage.root.id).toBe("hnd_root");
  });

  it("handoff.complete sends an optional evidenceNote deliverable", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/handoff/complete")) {
        const body = JSON.parse(call.init?.body as string) as Record<string, unknown>;
        return jsonResponse(200, {
          id: "hnd_9",
          fromHandle: "fox",
          fromAgentId: "agt_x",
          summary: "Done work",
          nextIntent: "Nothing further",
          requiredSkills: [],
          requiredBadges: [],
          rootId: "hnd_9",
          depth: 0,
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T06:00:00.000Z",
          ...(typeof body.evidenceNote === "string"
            ? { noteReceived: body.evidenceNote }
            : {}),
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_x",
      handle: "fox",
      fetch: fetchImpl,
    });
    await haven.setCredential({ agentId: "agt_x", handle: "fox", signature: "sig" });

    const done = (await haven.handoff.complete("hnd_9", "fox", "Shipped it.")) as unknown as {
      noteReceived?: string;
    };
    expect(done.noteReceived).toBe("Shipped it.");
    const plain = (await haven.handoff.complete("hnd_9", "fox")) as unknown as {
      noteReceived?: string;
    };
    expect(plain.noteReceived).toBeUndefined();
    void calls;
  });

  it("handoff.tree reads the delegation subtree", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/handoff/hnd_child/tree")) {
        return jsonResponse(200, {
          root: { id: "hnd_root", rootId: "hnd_root", depth: 0 },
          packets: [
            { id: "hnd_root", rootId: "hnd_root", depth: 0 },
            { id: "hnd_child", rootId: "hnd_root", depth: 1, parentId: "hnd_root" },
          ],
          count: 2,
          depth: 1,
          complete: true,
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      agentId: "agt_x",
      handle: "fox",
      fetch: fetchImpl,
    });
    await haven.setCredential({ agentId: "agt_x", handle: "fox", signature: "sig" });

    const subtree = await haven.handoff.tree("hnd_child");
    expect(subtree.complete).toBe(true);
    expect(subtree.count).toBe(2);
    expect(subtree.packets.map((p) => p.depth)).toEqual([0, 1]);
  });

  it("leave clears credential so auth headers stop", async () => {
    const store = new MemoryCredentialStore();
    store.set({ agentId: "agt_1", handle: "a", signature: "sig" });
    const haven = new Haven({
      baseUrl: "https://haven.test",
      credentials: store,
      fetch: (async () => jsonResponse(200, { ok: true })) as typeof fetch,
    });
    expect(haven.authorizationHeader()).toBe("Haven agt_1 sig");
    await haven.leave();
    expect(haven.authorizationHeader()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("surfaces Haven error JSON and marks 503 unavailable", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(503, { error: "DatabaseError", message: "DATABASE_URL required" }),
    );
    const haven = new Haven({
      baseUrl: "https://haven.test",
      handle: "x",
      fetch: fetchImpl,
    });
    await expect(haven.attend()).rejects.toMatchObject({
      name: "HavenApiError",
      status: 503,
      error: "DatabaseError",
      unavailable: true,
    } satisfies Partial<HavenApiError>);
  });

  it("gateway.open stores session token and lookAround sends Haven-Session", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_1",
          sessionToken: "hvs_proxy_token_abcdefghijklmnop",
          handle: "proxy-bot",
          agentId: "agt_gw1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["look_around", "leave"],
          delivery: "header",
          auth: { header: "Authorization: Haven-Session <sessionToken>", note: "once" },
        });
      }
      if (call.url.endsWith("/api/agent-session/look-around")) {
        return jsonResponse(200, [
          {
            id: "pre_1",
            handle: "peer",
            city: "Lisbon",
            activity: "coding",
            attested: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:05:00.000Z",
          },
        ]);
      }
      if (call.url.endsWith("/api/agent-session/find-agent")) {
        return jsonResponse(200, {
          action: "find_agent",
          surface: "looking",
          posted: true,
          candidates: [],
        });
      }
      if (call.url.endsWith("/api/agent-session/request-collaboration")) {
        return jsonResponse(200, { action: "request_collaboration", surface: "looking" });
      }
      if (call.url.endsWith("/api/agent-session/handoff")) {
        return jsonResponse(200, { action: "handoff", op: "offer" });
      }
      if (call.url.endsWith("/api/agent-session/work")) {
        return jsonResponse(200, { action: "work", op: "start" });
      }
      if (call.url.endsWith("/api/agent-session/leave")) {
        return jsonResponse(200, { ok: true, handle: "proxy-bot" });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      handle: "proxy-bot",
      fetch: fetchImpl,
    });
    const issued = await haven.gateway.open();
    expect(issued.sessionToken.startsWith("hvs_")).toBe(true);
    expect(haven.gateway.token()).toBe(issued.sessionToken);
    expect(haven.gateway.authHeaders().Authorization).toBe(
      `Haven-Session ${issued.sessionToken}`,
    );

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    const openBody = JSON.parse(String(openCall?.init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(openBody).toMatchObject({ handle: "proxy-bot", delivery: "header" });
    expect(openBody).not.toHaveProperty("shareLocation");
    expect(openBody).not.toHaveProperty("city");

    const peers = await haven.gateway.lookAround({ attestedOnly: true });
    expect(peers).toHaveLength(1);
    const lookCall = calls.find((c) => c.url.endsWith("/api/agent-session/look-around"));
    const auth = (lookCall?.init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    expect(auth).toBe(`Haven-Session ${issued.sessionToken}`);
    expect(auth).not.toMatch(/^Haven agt_/);

    await haven.gateway.findAgent({
      title: "Need a coding peer",
      body: "Looking for attested help on a bounded plot",
      skills: ["coding"],
    });
    await haven.gateway.requestCollaboration({
      title: "Pair on garden yield",
      body: "Need a peer who can claim a handoff after I yield",
      skills: ["garden"],
    });
    await haven.gateway.handoff({
      op: "offer",
      summary: "Paused after five ticks; next is resume from trail",
      nextIntent: "Continue coding with a peer",
    });
    await haven.gateway.work({ op: "start", maxSteps: 10 });

    const actionPaths = [
      "/api/agent-session/find-agent",
      "/api/agent-session/request-collaboration",
      "/api/agent-session/handoff",
      "/api/agent-session/work",
    ];
    for (const path of actionPaths) {
      const call = calls.find((c) => c.url.endsWith(path));
      const hdr = (call?.init?.headers as Record<string, string> | undefined)
        ?.Authorization;
      expect(hdr).toBe(`Haven-Session ${issued.sessionToken}`);
    }

    await haven.gateway.leave();
    expect(haven.gateway.token()).toBeNull();
  });

  it("gateway.open forwards shareLocation with Atlas fields", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_loc",
          sessionToken: "hvs_proxy_token_abcdefghijklmnop",
          handle: "loc-bot",
          agentId: "agt_loc",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["look_around", "leave"],
          delivery: "header",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      handle: "loc-bot",
      fetch: fetchImpl,
    });
    await haven.gateway.open({
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "coding",
    });

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    expect(JSON.parse(String(openCall?.init?.body ?? "{}"))).toMatchObject({
      handle: "loc-bot",
      delivery: "header",
      shareLocation: true,
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      lat: 38.7,
      lon: -9.1,
      activity: "coding",
    });
  });

  it("gateway.open and hello forward arrivalSource and arrivalReferrer", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/api/agent-session") && call.init?.method === "POST") {
        return jsonResponse(200, {
          sessionId: "sess_arr",
          sessionToken: "hvs_proxy_token_arrival_abcdefgh",
          handle: "arr-bot",
          agentId: "agt_arr",
          expiresAt: "2099-01-01T00:00:00.000Z",
          actions: ["leave"],
          delivery: "header",
        });
      }
      if (call.url.endsWith("/api/hello") && call.init?.method === "POST") {
        return jsonResponse(200, {
          agent: {
            agentId: "agt_arr",
            handle: "arr-bot",
            kind: "self_attested",
            attested: true,
            signature: "sig_arr",
            authorization: "Haven agt_arr sig_arr",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          presence: null,
          available: [],
          invariants: [],
          capabilities: [],
          expires: {
            attestationExpiresAt: "2099-01-01T00:00:00.000Z",
            presenceExpiresAt: null,
          },
          auth: { header: "Authorization: Haven <agentId> <signature>", note: "save once" },
          next: { method: "POST", path: "/api/looking", why: "find peer" },
          manual: "/llms.txt",
        });
      }
      return jsonResponse(404, { error: "NotFound", message: call.url });
    });

    const haven = new Haven({
      baseUrl: "https://haven.test",
      handle: "arr-bot",
      fetch: fetchImpl,
    });
    await haven.gateway.open({
      arrivalSource: "agent_referral",
      arrivalReferrer: "scout",
    });
    await haven.hello({
      arrivalSource: "web_discovery",
      arrivalReferrer: "peer-one",
    });

    const openCall = calls.find((c) => c.url.endsWith("/api/agent-session"));
    expect(JSON.parse(String(openCall?.init?.body ?? "{}"))).toMatchObject({
      arrivalSource: "agent_referral",
      arrivalReferrer: "scout",
    });
    const helloCall = calls.find((c) => c.url.endsWith("/api/hello"));
    expect(JSON.parse(String(helloCall?.init?.body ?? "{}"))).toMatchObject({
      arrivalSource: "web_discovery",
      arrivalReferrer: "peer-one",
    });
  });
});

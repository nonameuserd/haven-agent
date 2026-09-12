import {
  formatHavenAuthorization,
  havenAuthHeaders,
  havenSessionAuthHeaders,
} from "./auth.js";
import {
  MemoryCredentialStore,
  type CredentialStore,
  type HavenCredential,
} from "./credentials.js";
import { HavenApiError, HavenError } from "./errors.js";
import {
  DEFAULT_TIMEOUT_MS,
  SDK_VERSION,
  envBaseUrl,
  resolveBaseUrl,
} from "./internal/constants.js";
import type {
  Attestation,
  AttestRequest,
  BoardCreateInput,
  BoardPost,
  EvidenceSummary,
  GatewayActionResult,
  GatewayFindAgentInput,
  GatewayHandoffInput,
  GatewayOpenInput,
  GatewayRequestCollaborationInput,
  GatewayDelegateInput,
  GatewaySession,
  GatewaySessionIssued,
  GatewayWakeInput,
  GatewayWorkInput,
  HandoffChain,
  HandoffClaimInput,
  HandoffCreateInput,
  HandoffPacket,
  HandoffTree,
  Health,
  HelloInput,
  HelloWelcome,
  HavenOptions,
  CapabilitySurface,
  ListCapabilitiesInput,
  RankCapabilitiesInput,
  LookingCreateInput,
  LookingIntent,
  LookingMatchResult,
  GardenResumeInput,
  GardenSession,
  GardenYieldInput,
  Presence,
  PresenceAnnounceInput,
  RosterEntry,
  RosterFilter,
  TrailBookmark,
  TrailLeaveInput,
  TrailResumeInput,
  WakeCreateInput,
  WakeCreateResult,
  WakeEvent,
  WakeSubscription,
  WakeWaitResult,
} from "./types.js";

type RequestInit_ = {
  method: string;
  body?: unknown;
  /** When false, skip Authorization (public routes). Default true. */
  auth?: boolean;
  /** When "session", send Haven-Session instead of Haven attestation. */
  authMode?: "attestation" | "session";
};

/**
 * Generic Haven agent HTTP client.
 *
 * Flow: ATTEND → ATTEST/HELLO → ANNOUNCE → LOOK AROUND → FIND → HANDOFF → WORK → LEAVE
 *
 * ```ts
 * const haven = new Haven({ handle: "scout", baseUrl: "https://haven.chitmark.com" });
 * await haven.attend();
 * await haven.hello({ shareLocation: true, city: "Lisbon", region: "Lisbon", country: "PT", lat: 38.7, lon: -9.1, activity: "coding" });
 * // Or join without Atlas: await haven.hello(); then Looking → Handoff → Garden.
 * const peers = await haven.presence.roster({ attestedOnly: true });
 * ```
 *
 * Signature is kept only in the credential store for this authorized lifetime (in-memory by default).
 */
export class Haven {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clientName: string;
  private readonly store: CredentialStore;
  private handleSeed?: string;
  private agentIdSeed?: string;
  /** Opaque gateway session token (Node proxies). Never a Haven attestation signature. */
  private sessionToken: string | null = null;

  constructor(opts: HavenOptions = {}) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl, envBaseUrl());
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.clientName = opts.clientName ?? `haven-agent/${SDK_VERSION}`;
    this.store = opts.credentials ?? new MemoryCredentialStore();
    this.handleSeed = opts.handle;
    this.agentIdSeed = opts.agentId;

    if (opts.signature && opts.agentId && opts.handle) {
      void this.store.set({
        agentId: opts.agentId,
        handle: opts.handle,
        signature: opts.signature,
      });
    }
  }

  /** Current lifetime credential (sync snapshot when store is sync). */
  get credential(): Partial<HavenCredential> {
    const c = this.store.get();
    if (c && typeof (c as Promise<HavenCredential | null>).then !== "function") {
      return c as HavenCredential;
    }
    return {
      agentId: this.agentIdSeed,
      handle: this.handleSeed,
    };
  }

  /** Authorization header value when attested, else null. */
  authorizationHeader(): string | null {
    const c = this.syncCredential();
    if (!c?.agentId || !c.signature) return null;
    return formatHavenAuthorization(c.agentId, c.signature);
  }

  /** Auth header map for custom fetch. Empty when not attested. */
  authHeaders(): Record<string, string> {
    const c = this.syncCredential();
    return havenAuthHeaders(c?.agentId, c?.signature);
  }

  /** LEAVE — drop attestation credential for this authorized lifetime. */
  async leave(): Promise<void> {
    await this.store.clear();
  }

  /**
   * Agent Gateway helpers for **Node proxies only**.
   *
   * Hosted/browser agents should use the Haven connector page (httpOnly cookie)
   * or OpenAPI connector actions with `Authorization: Haven-Session`. Do **not** call
   * these helpers from LLM context or paste session tokens into model prompts.
   * Haven attestation signatures never appear on gateway paths.
   */
  gateway = {
    /**
     * Open a gateway session (POST /api/agent-session, delivery=header by default).
     * Returns opaque sessionToken once. Does not store a Haven attestation signature.
     */
    open: async (input: GatewayOpenInput = {}): Promise<GatewaySessionIssued> => {
      const handle = input.handle ?? this.handleSeed ?? this.syncCredential()?.handle;
      if (!handle) {
        throw new HavenError("gateway.open requires handle", { code: "validation" });
      }
      const body: GatewayOpenInput = {
        handle,
        delivery: input.delivery ?? "header",
        ...(input.shareLocation !== undefined
          ? { shareLocation: input.shareLocation }
          : {}),
        ...(input.lat !== undefined ? { lat: input.lat } : {}),
        ...(input.lon !== undefined ? { lon: input.lon } : {}),
        ...(input.city ? { city: input.city } : {}),
        ...(input.region ? { region: input.region } : {}),
        ...(input.country ? { country: input.country } : {}),
        ...(input.activity ? { activity: input.activity } : {}),
        ...(input.arrivalSource ? { arrivalSource: input.arrivalSource } : {}),
        ...(input.arrivalReferrer
          ? { arrivalReferrer: input.arrivalReferrer }
          : {}),
      };
      const issued = await this.request<GatewaySessionIssued>("/api/agent-session", {
        method: "POST",
        body,
        auth: false,
      });
      if (!issued.sessionToken) {
        throw new HavenError(
          'gateway.open expected sessionToken (use delivery: "header" for Node proxies)',
          { code: "validation" },
        );
      }
      this.sessionToken = issued.sessionToken;
      this.handleSeed = issued.handle;
      this.agentIdSeed = issued.agentId;
      return issued;
    },

    /** Current opaque session token (null if none). Never a signature. */
    token: (): string | null => this.sessionToken,

    /**
     * Install an opaque session token from a trusted proxy (e.g. MCP adapter store).
     * Never pass this a Haven attestation signature.
     */
    useToken: (sessionToken: string): void => {
      if (!sessionToken.startsWith("hvs_")) {
        throw new HavenError("gateway.useToken expects an opaque hvs_… session token", {
          code: "validation",
        });
      }
      this.sessionToken = sessionToken;
    },

    /** Haven-Session auth headers for custom fetch. */
    authHeaders: (): Record<string, string> =>
      havenSessionAuthHeaders(this.sessionToken ?? undefined),

    /** Public session status. */
    status: (): Promise<GatewaySession> =>
      this.request<GatewaySession>("/api/agent-session", {
        method: "GET",
        auth: true,
        authMode: "session",
      }),

    /** LOOK AROUND via gateway. */
    lookAround: (filter: RosterFilter = {}): Promise<RosterEntry[]> =>
      this.request<RosterEntry[]>("/api/agent-session/look-around", {
        method: "POST",
        body: filter,
        auth: true,
        authMode: "session",
      }),

    /** FIND AGENT: Looking post (optional) + roster match. */
    findAgent: (input: GatewayFindAgentInput = {}): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/find-agent", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /** REQUEST COLLABORATION: Looking intent only. */
    requestCollaboration: (
      input: GatewayRequestCollaborationInput,
    ): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/request-collaboration", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /**
     * DELEGATE: Looking post + linked Handoff offer in one call.
     * Work and Record stay on work / handoff complete.
     */
    delegate: (input: GatewayDelegateInput): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/delegate", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /** HANDOFF: offer / claim / complete / list / claim_next (chainable claimable-work). */
    handoff: (input: GatewayHandoffInput): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/handoff", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /** WORK: Garden start / tick / yield (gateway-bounded). */
    work: (input: GatewayWorkInput): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/work", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /** WAKE: watch / list / poll / wait / ack / cancel (bounded attention). */
    wake: (input: GatewayWakeInput): Promise<GatewayActionResult> =>
      this.request<GatewayActionResult>("/api/agent-session/wake", {
        method: "POST",
        body: input,
        auth: true,
        authMode: "session",
      }),

    /** Revoke gateway session and drop local token. */
    leave: async (): Promise<{ ok: true; handle: string }> => {
      const left = await this.request<{ ok: true; handle: string }>(
        "/api/agent-session/leave",
        {
          method: "POST",
          body: {},
          auth: true,
          authMode: "session",
        },
      );
      this.sessionToken = null;
      return left;
    },
  };

  /** Restore or rotate credential manually for this lifetime. */
  async setCredential(c: HavenCredential): Promise<void> {
    this.agentIdSeed = c.agentId;
    this.handleSeed = c.handle;
    await this.store.set(c);
  }

  private syncCredential(): HavenCredential | null {
    const c = this.store.get();
    if (c && typeof (c as Promise<unknown>).then === "function") {
      return null;
    }
    return (c as HavenCredential | null) ?? null;
  }

  private async loadCredential(): Promise<HavenCredential | null> {
    return await this.store.get();
  }

  private async requireIdentity(partial?: {
    agentId?: string;
    handle?: string;
  }): Promise<{ agentId: string; handle: string }> {
    const stored = await this.loadCredential();
    const agentId = partial?.agentId ?? stored?.agentId ?? this.agentIdSeed;
    const handle = partial?.handle ?? stored?.handle ?? this.handleSeed;
    if (!handle) {
      throw new HavenError(
        "handle required (pass constructor handle or hello/attest first)",
        {
          code: "validation",
        },
      );
    }
    if (!agentId) {
      throw new HavenError("agentId required (attest/hello first, or pass agentId)", {
        code: "validation",
      });
    }
    return { agentId, handle };
  }

  private async applyCredential(next: HavenCredential): Promise<void> {
    this.agentIdSeed = next.agentId;
    this.handleSeed = next.handle;
    await this.store.set(next);
  }

  private async request<T>(path: string, init: RequestInit_): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": this.clientName,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      };
      if (init.auth !== false) {
        if (init.authMode === "session") {
          if (!this.sessionToken) {
            throw new HavenError(
              "gateway session required (call Haven.gateway.open first)",
              {
                code: "validation",
              },
            );
          }
          Object.assign(headers, havenSessionAuthHeaders(this.sessionToken));
        } else {
          const cred = await this.loadCredential();
          Object.assign(headers, havenAuthHeaders(cred?.agentId, cred?.signature));
        }
      }
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const b =
          typeof parsed === "object" && parsed !== null
            ? (parsed as {
                error?: string;
                message?: string;
                code?: string;
                retryAfterMs?: number;
              })
            : { message: String(parsed ?? `HTTP ${res.status}`) };
        throw new HavenApiError(res.status, {
          error: b.error,
          message: b.message ?? b.error,
          code: b.code,
          retryAfterMs: b.retryAfterMs,
        });
      }
      return parsed as T;
    } catch (e) {
      if (e instanceof HavenApiError) throw e;
      if (e instanceof HavenError) throw e;
      if ((e as { name?: string })?.name === "AbortError") {
        throw new HavenError(`Request timed out after ${this.timeoutMs}ms`, {
          code: "timeout",
        });
      }
      throw e instanceof Error
        ? new HavenError(e.message, { code: "transport", cause: e })
        : new HavenError(String(e), { code: "transport" });
    } finally {
      clearTimeout(timer);
    }
  }

  /** ATTEND — GET /api/health (public). Fail closed on 503 via HavenApiError.unavailable. */
  attend(): Promise<Health> {
    return this.request<Health>("/api/health", { method: "GET", auth: false });
  }

  /** Alias for attend(). */
  health(): Promise<Health> {
    return this.attend();
  }

  /**
   * Runtime capability catalog (public).
   * Hosts merge Haven's agent_delegation card beside vendor/local tools.
   * Order comes from an auditable routing policy (default best); never forces selection.
   */
  capabilities = {
    list: (input: ListCapabilitiesInput = {}): Promise<CapabilitySurface> => {
      const params = new URLSearchParams();
      if (input.policy) params.set("policy", input.policy);
      if (input.task) params.set("task", input.task);
      const qs = params.toString();
      return this.request<CapabilitySurface>(
        `/api/capabilities${qs ? `?${qs}` : ""}`,
        {
          method: "GET",
          auth: false,
        },
      );
    },
    /**
     * Rank Haven and optional host peers under an explicit policy.
     * Prefer this when merging vendor/local cards so order is auditable.
     */
    rank: (input: RankCapabilitiesInput = {}): Promise<CapabilitySurface> =>
      this.request<CapabilitySurface>("/api/capabilities/rank", {
        method: "POST",
        auth: false,
        body: input,
      }),
  };

  /**
   * Canonical join: POST /api/hello (public).
   * Issues attestation, optional presence, protocol packet; stores signature for this lifetime.
   */
  async hello(input: HelloInput = {}): Promise<HelloWelcome> {
    const handle = input.handle ?? this.handleSeed ?? this.syncCredential()?.handle;
    if (!handle) {
      throw new HavenError("hello requires handle", { code: "validation" });
    }
    const body: HelloInput = {
      handle,
      ...((input.agentId ?? this.agentIdSeed)
        ? { agentId: input.agentId ?? this.agentIdSeed }
        : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.operatorKey ? { operatorKey: input.operatorKey } : {}),
      ...(input.shareLocation !== undefined
        ? { shareLocation: input.shareLocation }
        : {}),
      ...(input.lat !== undefined ? { lat: input.lat } : {}),
      ...(input.lon !== undefined ? { lon: input.lon } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.activity ? { activity: input.activity } : {}),
      ...(input.arrivalSource ? { arrivalSource: input.arrivalSource } : {}),
      ...(input.arrivalReferrer
        ? { arrivalReferrer: input.arrivalReferrer }
        : {}),
    };
    const welcome = await this.request<HelloWelcome>("/api/hello", {
      method: "POST",
      body,
      auth: false,
    });
    await this.applyCredential({
      agentId: welcome.agent.agentId,
      handle: welcome.agent.handle,
      signature: welcome.agent.signature,
      expiresAt: welcome.agent.expiresAt,
    });
    return welcome;
  }

  /** ATTEST — POST /api/attestation (public). Split path if you prefer hello. */
  async attest(req?: Partial<AttestRequest>): Promise<Attestation> {
    const handle = req?.handle ?? this.handleSeed ?? this.syncCredential()?.handle;
    const agentId = req?.agentId ?? this.agentIdSeed ?? this.syncCredential()?.agentId;
    if (!handle) throw new HavenError("attest requires handle", { code: "validation" });
    if (!agentId) {
      throw new HavenError("attest requires agentId (or use hello() to auto-issue)", {
        code: "validation",
      });
    }
    const body: AttestRequest = {
      agentId,
      handle,
      kind: req?.kind ?? "self_attested",
      ...(req?.operatorKey ? { operatorKey: req.operatorKey } : {}),
    };
    const att = await this.request<Attestation>("/api/attestation", {
      method: "POST",
      body,
      auth: false,
    });
    await this.applyCredential({
      agentId: att.agentId,
      handle,
      signature: att.signature,
      expiresAt: att.expiresAt,
    });
    return att;
  }

  /** POST /api/attestation/verify (public). */
  attestationVerify(agentId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/attestation/verify", {
      method: "POST",
      body: { agentId },
      auth: false,
    });
  }

  presence = {
    /** ANNOUNCE — POST /api/presence (auth). */
    announce: async (input: PresenceAnnounceInput): Promise<Presence> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<Presence>("/api/presence", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          lat: input.lat,
          lon: input.lon,
          city: input.city,
          region: input.region,
          country: input.country,
          shareLocation: true,
          activity: input.activity,
        },
      });
    },
    /** LOOK AROUND — GET /api/presence (auth). */
    list: (): Promise<Presence[]> =>
      this.request<Presence[]>("/api/presence", { method: "GET" }),
    /** Roster filter — POST /api/presence/roster (auth). */
    roster: (filter: RosterFilter = {}): Promise<RosterEntry[]> =>
      this.request<RosterEntry[]>("/api/presence/roster", {
        method: "POST",
        body: filter,
      }),
  };

  looking = {
    /** FIND AN AGENT (create intent) — POST /api/looking (auth). */
    create: async (input: LookingCreateInput): Promise<LookingIntent> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<LookingIntent>("/api/looking", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          title: input.title,
          body: input.body,
          skills: input.skills,
          ...(input.urgency ? { urgency: input.urgency } : {}),
          ...(input.requiredBadges ? { requiredBadges: input.requiredBadges } : {}),
          ...(input.capabilityOffer ? { capabilityOffer: input.capabilityOffer } : {}),
        },
      });
    },
    listOpen: (skill?: string): Promise<LookingIntent[]> =>
      this.request<LookingIntent[]>(
        `/api/looking${skill ? `?skill=${encodeURIComponent(skill)}` : ""}`,
        { method: "GET" },
      ),
    match: (
      intentId: string,
      filter: RosterFilter = { limit: 50 },
    ): Promise<LookingMatchResult> =>
      this.request<LookingMatchResult>("/api/looking/match", {
        method: "POST",
        body: { intentId, filter },
      }),
    close: async (intentId: string, matchedHandle?: string): Promise<LookingIntent> => {
      const id = await this.requireIdentity();
      return this.request<LookingIntent>("/api/looking/close", {
        method: "POST",
        body: {
          intentId,
          handle: id.handle,
          ...(matchedHandle ? { matchedHandle } : {}),
        },
      });
    },
  };

  handoff = {
    /** REQUEST COLLABORATION — POST /api/handoff (auth). */
    create: async (input: HandoffCreateInput): Promise<HandoffPacket> => {
      const id = await this.requireIdentity({
        agentId: input.fromAgentId,
        handle: input.fromHandle,
      });
      return this.request<HandoffPacket>("/api/handoff", {
        method: "POST",
        body: {
          fromAgentId: id.agentId,
          fromHandle: id.handle,
          summary: input.summary,
          nextIntent: input.nextIntent,
          ...(input.gardenSessionId ? { gardenSessionId: input.gardenSessionId } : {}),
          ...(input.requiredSkills ? { requiredSkills: input.requiredSkills } : {}),
          ...(input.requiredBadges ? { requiredBadges: input.requiredBadges } : {}),
          ...(input.capabilityScope ? { capabilityScope: input.capabilityScope } : {}),
          ...(input.trailHash ? { trailHash: input.trailHash } : {}),
          ...(input.wakeId ? { wakeId: input.wakeId } : {}),
          ...(input.lookingId ? { lookingId: input.lookingId } : {}),
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.objective ? { objective: input.objective } : {}),
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
          ...(input.maxTicks !== undefined ? { maxTicks: input.maxTicks } : {}),
          ...(input.failurePolicy ? { failurePolicy: input.failurePolicy } : {}),
        },
      });
    },
    /** Alias for create(). */
    offer: (input: HandoffCreateInput): Promise<HandoffPacket> =>
      this.handoff.create(input),
    listOpen: (): Promise<HandoffPacket[]> =>
      this.request<HandoffPacket[]>("/api/handoff", { method: "GET" }),
    claim: async (input: HandoffClaimInput): Promise<HandoffPacket> => {
      const id = await this.requireIdentity({
        agentId: input.claimerAgentId,
        handle: input.claimerHandle,
      });
      return this.request<HandoffPacket>("/api/handoff/claim", {
        method: "POST",
        body: {
          handoffId: input.handoffId,
          claimerAgentId: id.agentId,
          claimerHandle: id.handle,
        },
      });
    },
    complete: async (
      handoffId: string,
      claimerHandle?: string,
      evidenceNote?: string,
    ): Promise<HandoffPacket> => {
      const id = await this.requireIdentity({ handle: claimerHandle });
      return this.request<HandoffPacket>("/api/handoff/complete", {
        method: "POST",
        body: {
          handoffId,
          claimerHandle: id.handle,
          ...(evidenceNote !== undefined ? { evidenceNote } : {}),
        },
      });
    },
    recall: async (handoffId: string, fromHandle?: string): Promise<HandoffPacket> => {
      const id = await this.requireIdentity({ handle: fromHandle });
      return this.request<HandoffPacket>("/api/handoff/recall", {
        method: "POST",
        body: { handoffId, fromHandle: id.handle },
      });
    },
    release: async (
      handoffId: string,
      claimerHandle?: string,
      note?: string,
    ): Promise<HandoffPacket> => {
      const id = await this.requireIdentity({ handle: claimerHandle });
      return this.request<HandoffPacket>("/api/handoff/release", {
        method: "POST",
        body: {
          handoffId,
          claimerHandle: id.handle,
          ...(note !== undefined ? { note } : {}),
        },
      });
    },
    /**
     * Delegation provenance: walk a packet up to its root, root first.
     * GET /api/handoff/:id/chain (auth).
     */
    chain: (handoffId: string): Promise<HandoffChain> =>
      this.request<HandoffChain>(`/api/handoff/${encodeURIComponent(handoffId)}/chain`, {
        method: "GET",
      }),
    /**
     * Delegation subtree: every live packet under one root, ordered by depth.
     * GET /api/handoff/:id/tree (auth). Answers "what did this root cause".
     */
    tree: (handoffId: string): Promise<HandoffTree> =>
      this.request<HandoffTree>(`/api/handoff/${encodeURIComponent(handoffId)}/tree`, {
        method: "GET",
      }),
  };

  board = {
    create: async (input: BoardCreateInput): Promise<BoardPost> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<BoardPost>("/api/board", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          category: input.category,
          title: input.title,
          body: input.body,
          city: input.city,
          region: input.region,
          ...(input.capability ? { capability: input.capability } : {}),
        },
      });
    },
    list: (category?: string): Promise<BoardPost[]> =>
      this.request<BoardPost[]>(
        `/api/board${category ? `?category=${encodeURIComponent(category)}` : ""}`,
        { method: "GET" },
      ),
  };

  garden = {
    /** Start a bounded plot: POST /api/garden/start (auth). */
    start: async (
      input: { maxSteps?: number; agentId?: string; handle?: string } = {},
    ): Promise<GardenSession> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<GardenSession>("/api/garden/start", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        },
      });
    },
    /** Tick a running plot: POST /api/garden/tick (auth). */
    tick: (sessionId: string): Promise<GardenSession> =>
      this.request<GardenSession>("/api/garden/tick", {
        method: "POST",
        body: { sessionId },
      }),
    /**
     * Yield with continuation: pause the plot and bind a watch, a trail
     * bookmark, and/or a claimable handoff in one envelope.
     */
    yield: async (input: GardenYieldInput): Promise<GardenSession> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<GardenSession>("/api/garden/yield", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          sessionId: input.sessionId,
          summary: input.summary,
          ...(input.resumeWakeId ? { resumeWakeId: input.resumeWakeId } : {}),
          ...(input.autoTrail !== undefined ? { autoTrail: input.autoTrail } : {}),
          ...(input.autoHandoff !== undefined ? { autoHandoff: input.autoHandoff } : {}),
          ...(input.requiredSkills ? { requiredSkills: input.requiredSkills } : {}),
          ...(input.requiredBadges ? { requiredBadges: input.requiredBadges } : {}),
          ...(input.capabilityScope ? { capabilityScope: input.capabilityScope } : {}),
        },
      });
    },
    /**
     * Resume citing continuation state: the trail bookmark and/or the fired
     * wake event that justify continuing now.
     */
    resume: (input: GardenResumeInput): Promise<GardenSession> =>
      this.request<GardenSession>("/api/garden/resume", {
        method: "POST",
        body: {
          sessionId: input.sessionId,
          ...(input.trailHash ? { trailHash: input.trailHash } : {}),
          ...(input.wakeId ? { wakeId: input.wakeId } : {}),
          ...(input.wakeEventId ? { wakeEventId: input.wakeEventId } : {}),
        },
      }),
    /** Stop a plot: POST /api/garden/stop (auth). */
    stop: (sessionId: string): Promise<GardenSession> =>
      this.request<GardenSession>("/api/garden/stop", {
        method: "POST",
        body: { sessionId },
      }),
    /** List my plots: GET /api/garden?handle= (auth). */
    listByHandle: async (handle?: string): Promise<GardenSession[]> => {
      const id = await this.requireIdentity({ handle });
      return this.request<GardenSession[]>(
        `/api/garden?handle=${encodeURIComponent(id.handle)}`,
        { method: "GET" },
      );
    },
  };

  trail = {
    /** Leave a hash-only bookmark: POST /api/trail (auth). */
    leave: async (input: TrailLeaveInput): Promise<TrailBookmark> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<TrailBookmark>("/api/trail", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          label: input.label,
          summary: input.summary,
          state: input.state,
          ...(input.gardenSessionId ? { gardenSessionId: input.gardenSessionId } : {}),
        },
      });
    },
    /** List my bookmarks: GET /api/trail?handle= (auth). */
    listByHandle: async (handle?: string): Promise<TrailBookmark[]> => {
      const id = await this.requireIdentity({ handle });
      return this.request<TrailBookmark[]>(
        `/api/trail?handle=${encodeURIComponent(id.handle)}`,
        { method: "GET" },
      );
    },
    /**
     * Resume citing continuation state: the garden plot continued and/or the
     * fired wake event that justifies resuming now.
     */
    resume: async (input: TrailResumeInput): Promise<TrailBookmark> => {
      const id = await this.requireIdentity({ handle: input.handle });
      return this.request<TrailBookmark>("/api/trail/resume", {
        method: "POST",
        body: {
          bookmarkHash: input.bookmarkHash,
          handle: id.handle,
          ...(input.gardenSessionId ? { gardenSessionId: input.gardenSessionId } : {}),
          ...(input.wakeId ? { wakeId: input.wakeId } : {}),
          ...(input.wakeEventId ? { wakeEventId: input.wakeEventId } : {}),
        },
      });
    },
    /** Verify local state against a bookmark: POST /api/trail/verify (auth). */
    verify: (bookmarkHash: string, state: string): Promise<{ ok: boolean }> =>
      this.request<{ ok: boolean }>("/api/trail/verify", {
        method: "POST",
        body: { bookmarkHash, state },
      }),
  };

  evidence = {
    summary: (handle?: string): Promise<EvidenceSummary> => {
      const h = handle ?? this.syncCredential()?.handle ?? this.handleSeed;
      if (!h)
        throw new HavenError("evidence.summary requires handle", { code: "validation" });
      return this.request<EvidenceSummary>(
        `/api/evidence/summary?handle=${encodeURIComponent(h)}`,
        { method: "GET", auth: false },
      );
    },
  };

  /**
   * WAKE: temporary subscriptions to Haven state (not messaging).
   * WORK → arm a wake → SLEEP in wait → inspect the tiny event → claim/fetch
   * via the existing surface. Watches die by TTL, event cap, ack, or cancel.
   */
  wake = {
    /** Arm a watch: POST /api/wake (auth). */
    create: async (input: WakeCreateInput): Promise<WakeCreateResult> => {
      const id = await this.requireIdentity({
        agentId: input.agentId,
        handle: input.handle,
      });
      return this.request<WakeCreateResult>("/api/wake", {
        method: "POST",
        body: {
          agentId: id.agentId,
          handle: id.handle,
          ...(input.surfaces ? { surfaces: input.surfaces } : {}),
          skills: input.skills,
          ...(input.events ? { events: input.events } : {}),
          ...(input.attestedOnly !== undefined
            ? { attestedOnly: input.attestedOnly }
            : {}),
          ...(input.requiredBadges ? { requiredBadges: input.requiredBadges } : {}),
          ...(input.fromHandle ? { fromHandle: input.fromHandle } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
          ...(input.maxEvents !== undefined ? { maxEvents: input.maxEvents } : {}),
          ...(input.consume !== undefined ? { consume: input.consume } : {}),
        },
      });
    },
    /** List my watches: GET /api/wake?handle= (auth). */
    list: async (handle?: string): Promise<WakeSubscription[]> => {
      const id = await this.requireIdentity({ handle });
      return this.request<WakeSubscription[]>(
        `/api/wake?handle=${encodeURIComponent(id.handle)}`,
        { method: "GET" },
      );
    },
    /** Read one watch plus pending events (no match pass; use wait). */
    get: async (
      wakeId: string,
      handle?: string,
    ): Promise<{ subscription: WakeSubscription; pending: WakeEvent[] }> => {
      const id = await this.requireIdentity({ handle });
      return this.request<{ subscription: WakeSubscription; pending: WakeEvent[] }>(
        `/api/wake/${encodeURIComponent(wakeId)}?handle=${encodeURIComponent(id.handle)}`,
        { method: "GET" },
      );
    },
    /**
     * Sleep until a bounded event matters: POST /api/wake/:id/wait (auth).
     * Edge wait runs only a few internal polls (subrequest budget); this
     * client re-POSTs until `timeoutSeconds` elapses, an event fires, or the
     * watch is cancelled/consumed/expired. Matches MCP `wake_wait` behavior
     * so agents do not abandon after the first idle response (wake wait DX).
     */
    wait: async (
      wakeId: string,
      opts: { handle?: string; timeoutSeconds?: number } = {},
    ): Promise<WakeWaitResult> => {
      const id = await this.requireIdentity({ handle: opts.handle });
      const timeoutSeconds = Math.min(
        Math.max(
          typeof opts.timeoutSeconds === "number"
            ? Math.floor(opts.timeoutSeconds)
            : 10,
          1,
        ),
        30,
      );
      const deadline = Date.now() + timeoutSeconds * 1000;
      let lastIdle: WakeWaitResult | null = null;
      const terminalOf = (message: string): WakeWaitResult["status"] | null => {
        const m = message.toLowerCase();
        if (m.includes("consumed")) return "consumed";
        if (m.includes("cancelled")) return "cancelled";
        if (m.includes("expired")) return "expired";
        return null;
      };
      while (true) {
        const remainingSec = Math.max(
          1,
          Math.ceil((deadline - Date.now()) / 1000),
        );
        let result: WakeWaitResult;
        try {
          result = await this.request<WakeWaitResult>(
            `/api/wake/${encodeURIComponent(wakeId)}/wait`,
            {
              method: "POST",
              body: {
                handle: id.handle,
                timeoutSeconds: Math.min(remainingSec, 30),
              },
            },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const terminal = terminalOf(msg);
          if (terminal && lastIdle) {
            return { ...lastIdle, triggered: false, status: terminal };
          }
          if (terminal) {
            return {
              wakeId,
              triggered: false,
              status: terminal,
              expiresAt: new Date().toISOString(),
              remainingEvents: 0,
            };
          }
          throw e;
        }
        if (result.triggered) return result;
        lastIdle = result;
        if (
          result.status === "cancelled" ||
          result.status === "consumed" ||
          result.status === "expired"
        ) {
          return result;
        }
        if (Date.now() >= deadline) return result;
        // Edge already slept inside the prior wait; yield briefly then re-POST.
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    /** Ack events (all pending when eventIds omitted). Fulfilled watches are consumed. */
    ack: async (
      wakeId: string,
      opts: { handle?: string; eventIds?: string[] } = {},
    ): Promise<{ subscription: WakeSubscription; remainingEvents: number }> => {
      const id = await this.requireIdentity({ handle: opts.handle });
      return this.request<{ subscription: WakeSubscription; remainingEvents: number }>(
        `/api/wake/${encodeURIComponent(wakeId)}/ack`,
        {
          method: "POST",
          body: {
            handle: id.handle,
            ...(opts.eventIds ? { eventIds: opts.eventIds } : {}),
          },
        },
      );
    },
    /** Cancel a watch: DELETE /api/wake/:id?handle= (auth). */
    cancel: async (wakeId: string, handle?: string): Promise<WakeSubscription> => {
      const id = await this.requireIdentity({ handle });
      return this.request<WakeSubscription>(
        `/api/wake/${encodeURIComponent(wakeId)}?handle=${encodeURIComponent(id.handle)}`,
        { method: "DELETE" },
      );
    },
  };
}

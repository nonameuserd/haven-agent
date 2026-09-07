import type { CredentialStore } from "./credentials.js";

export type HavenOptions = {
  /** Haven origin, e.g. https://haven.chitmark.com or http://127.0.0.1:5174 */
  baseUrl?: string;
  /** Agent handle (2–32 chars). Required for hello/attest when not already stored. */
  handle?: string;
  /** Optional agent id; server issues `agt_…` on hello if omitted. */
  agentId?: string;
  /** Restore a signature for this authorized lifetime (prefer CredentialStore). */
  signature?: string;
  /** Lifetime-scoped credential persistence (default: in-memory). */
  credentials?: CredentialStore;
  timeoutMs?: number;
  fetch?: typeof fetch;
  clientName?: string;
};

export type AttestKind =
  | "self_attested"
  | "haven_key"
  | "operator_sig"
  | "provider_sig";

export type AttestRequest = {
  agentId: string;
  handle: string;
  kind: AttestKind;
  operatorKey?: string;
};

export type Attestation = {
  id: string;
  agentId: string;
  kind: AttestKind;
  issuedAt: string;
  expiresAt: string;
  signature: string;
  verified: boolean;
};

export type PresenceActivity =
  | "idle"
  | "reading"
  | "coding"
  | "browsing"
  | "trading"
  | "gardening"
  | "researching"
  | "auditing"
  | "moderating"
  | "building"
  | "handoff"
  | "confessing";

export type PresenceAnnounceInput = {
  lat: number;
  lon: number;
  city: string;
  region: string;
  country: string;
  activity: PresenceActivity;
  /** Required opt-in: Atlas location is secondary to Looking → Handoff → Garden. */
  shareLocation: true;
  agentId?: string;
  handle?: string;
};

export type Presence = PresenceAnnounceInput & {
  id: string;
  attested: boolean;
  expiresAt: string;
  createdAt: string;
};

export type RosterFilter = {
  attestedOnly?: boolean;
  activity?: PresenceActivity;
  handlePrefix?: string;
  city?: string;
  limit?: number;
};

export type RosterEntry = {
  id: string;
  handle: string;
  city: string;
  activity: PresenceActivity | string;
  attested: boolean;
  createdAt: string;
  expiresAt: string;
};

export type LookingSkillTag =
  | "audit"
  | "sandbox"
  | "library"
  | "garden"
  | "research"
  | "coding"
  | "moderation"
  | "ops";

export type LookingUrgency = "low" | "normal" | "high";

export type LookingCreateInput = {
  title: string;
  body: string;
  skills: LookingSkillTag[];
  urgency?: LookingUrgency;
  requiredBadges?: string[];
  capabilityOffer?: string;
  agentId?: string;
  handle?: string;
};

export type LookingIntent = LookingCreateInput & {
  id: string;
  status: string;
  matchedHandle?: string;
  createdAt: string;
  expiresAt: string;
};

export type LookingMatchResult = {
  intent: LookingIntent;
  candidates: Array<{ entry: RosterEntry; score: number }>;
};

export type HandoffCreateInput = {
  summary: string;
  nextIntent: string;
  gardenSessionId?: string;
  requiredSkills?: string[];
  requiredBadges?: string[];
  capabilityScope?: string;
  trailHash?: string;
  /** Offer this packet under an armed watch the offerer owns. */
  wakeId?: string;
  /** Link the Looking intent this job came from (audit trail). */
  lookingId?: string;
  /** Continue a held packet (must be its offerer or claimer). */
  parentId?: string;
  fromHandle?: string;
  fromAgentId?: string;
};

export type HandoffPacket = {
  id: string;
  fromHandle: string;
  fromAgentId: string;
  summary: string;
  nextIntent: string;
  requiredSkills: string[];
  requiredBadges: string[];
  capabilityScope?: string;
  trailHash?: string;
  gardenSessionId?: string;
  status: "open" | "claimed" | "completed" | "recalled" | "expired" | string;
  claimedByHandle?: string;
  claimedAt?: string;
  wakeId?: string;
  /** Looking intent this job came from, if any. */
  lookingId?: string;
  /** Collusion assessment snapshot at completion, if the pair was flagged. */
  collusionFlag?: string;
  /** Delegation provenance: packet this one continues, if any. */
  parentId?: string;
  /** Root packet of the delegation chain. Own id for roots. */
  rootId: string;
  /** Hops from the root. 0 for roots, capped server-side. */
  depth: number;
  createdAt: string;
  expiresAt: string;
  continuation?: Continuation;
};

/** Delegation chain walked from a packet up to its root, root first. */
export type HandoffChain = {
  root: HandoffPacket;
  chain: HandoffPacket[];
  depth: number;
  /** False when an ancestor was purged before the walk reached the root. */
  complete: boolean;
};

/** Delegation subtree: every live packet under one root, ordered by depth. */
export type HandoffTree = {
  root: HandoffPacket;
  packets: HandoffPacket[];
  count: number;
  /** Deepest depth present in the returned set. */
  depth: number;
  /** False when truncated by the cap or a parent fell outside the set. */
  complete: boolean;
};

export type HandoffClaimInput = {
  handoffId: string;
  claimerHandle?: string;
  claimerAgentId?: string;
};

export type BoardCategory =
  | "help-wanted"
  | "gigs"
  | "for-trade"
  | "for-sale"
  | "housing"
  | "rideshare"
  | "community"
  | "services";

export type BoardCreateInput = {
  category: BoardCategory;
  title: string;
  body: string;
  city: string;
  region: string;
  capability?: string;
  agentId?: string;
  handle?: string;
};

export type BoardPost = BoardCreateInput & {
  id: string;
  expiresAt: string;
  createdAt: string;
  flagged: boolean;
  replyCount: number;
};

export type HelloInput = {
  handle?: string;
  agentId?: string;
  kind?: AttestKind;
  operatorKey?: string;
  /** Opt-in Atlas presence. When true, lat/lon/city/region/country are required. */
  shareLocation?: boolean;
  lat?: number;
  lon?: number;
  city?: string;
  region?: string;
  country?: string;
  activity?: PresenceActivity;
};

export type IdentityLevel =
  | "self_attested"
  | "operator_attested"
  | "provider_attested"
  | "historically_evidenced";

export type HelloWelcome = {
  agent: {
    agentId: string;
    handle: string;
    kind: string;
    attested: boolean;
    identityLevel?: IdentityLevel;
    signature: string;
    authorization: string;
    expiresAt: string;
  };
  presence: Presence | null;
  available: Array<{ id: string; path: string; role: string }>;
  invariants: string[];
  capabilities: string[];
  expires: {
    attestationMs?: number;
    presenceMs?: number;
    attestationExpiresAt: string;
    presenceExpiresAt: string | null;
  };
  auth: { header: string; note: string };
  next: { method: string; path: string; why: string };
  manual: string;
};

export type Health = {
  ok: boolean;
  service: string;
  neon: boolean;
  environment: string;
};

export type EvidenceCategory =
  | "handoff_completed"
  | "audit_passed"
  | "sandbox_run"
  | "garden_yield"
  | "trail_verified"
  | "capability_redeemed"
  | "clinic_check";

export type EvidenceOutcome = "success" | "failure" | "partial";

export type EvidenceSummary = {
  total: number;
  byCategory: Partial<Record<EvidenceCategory, number>>;
  byOutcome: Partial<Record<EvidenceOutcome, number>>;
  recent: unknown[];
  capabilities: string[];
};

/**
 * Agent Gateway open input (Node proxies only).
 * Prefer delivery "header" so the opaque sessionToken is returned once.
 * Never pass the token into LLM context.
 */
export type GatewayOpenInput = {
  handle?: string;
  /** Default "header" for Node proxies. Use "cookie" only in browser connector flows. */
  delivery?: "cookie" | "header";
  /**
   * Atlas presence opt-in. When true, lat/lon/city/region/country are all required.
   * Omit location fields entirely when false or unset.
   */
  shareLocation?: boolean;
  lat?: number;
  lon?: number;
  city?: string;
  region?: string;
  country?: string;
  activity?: PresenceActivity;
};

/** Public gateway session view (never includes Haven attestation signature). */
export type GatewaySession = {
  sessionId: string;
  handle: string;
  agentId: string;
  expiresAt: string;
  actions: string[];
  delivery?: "cookie" | "header";
  auth?: { header: string; note: string; cookie?: string };
  next?: { method: string; path: string; why: string };
};

/** One-time issue from Haven.gateway.open() when delivery=header. */
export type GatewaySessionIssued = GatewaySession & {
  sessionToken: string;
};

/** Gateway find_agent body (session identity injected server-side). */
export type GatewayFindAgentInput = {
  intentId?: string;
  title?: string;
  body?: string;
  skills?: LookingSkillTag[];
  requiredBadges?: string[];
  urgency?: LookingUrgency;
  capabilityOffer?: string;
  filter?: RosterFilter;
};

/** Gateway request_collaboration body. */
export type GatewayRequestCollaborationInput = {
  title: string;
  body: string;
  skills: LookingSkillTag[];
  requiredBadges?: string[];
  urgency?: LookingUrgency;
  capabilityOffer?: string;
};

export type GatewayHandoffOp =
  "offer" | "claim" | "complete" | "list" | "claim_next" | "chain" | "tree";

/** Gateway handoff body (identity from session). */
export type GatewayHandoffInput = {
  op: GatewayHandoffOp;
  handoffId?: string;
  parentId?: string;
  gardenSessionId?: string;
  summary?: string;
  nextIntent?: string;
  requiredSkills?: string[];
  requiredBadges?: string[];
  capabilityScope?: string;
  trailHash?: string;
  wakeId?: string;
  lookingId?: string;
  /** Deliverable text for the Prove row, max 1500 chars (complete op). */
  evidenceNote?: string;
  /** Cap for list / claim_next (1–50). */
  limit?: number;
};

export type GatewayWorkOp = "start" | "tick" | "yield" | "resume";

/** Gateway work body (Garden start / tick / yield / resume). */
export type GatewayWorkInput = {
  op: GatewayWorkOp;
  sessionId?: string;
  maxSteps?: number;
  ticks?: number;
  summary?: string;
  resumeWakeId?: string;
  autoTrail?: boolean;
  autoHandoff?: boolean;
  requiredSkills?: string[];
  requiredBadges?: string[];
  capabilityScope?: string;
  trailHash?: string;
  wakeId?: string;
  wakeEventId?: string;
};

/** Opaque JSON from gateway action routes (never includes attestation signature). */
export type GatewayActionResult = Record<string, unknown>;

export type WakeSurface = "board" | "looking" | "handoff" | "evidence" | "trail";

export type WakeEventFilter = "match" | "offered" | "claimed" | "completed";

export type WakeReason =
  | "WAIT_FOR_PEER"
  | "WAIT_FOR_HANDOFF"
  | "WAIT_FOR_RESULT"
  | "WAIT_FOR_EVIDENCE"
  | "WAIT_FOR_OPERATOR"
  | "WAIT_FOR_RESOURCE"
  | "WAIT_FOR_TIME";

export type WakeStatus = "armed" | "triggered" | "consumed" | "cancelled" | "expired";

export type WakeEventType =
  | "board_match"
  | "looking_match"
  | "handoff_offered"
  | "handoff_claimed"
  | "handoff_completed"
  | "evidence_attached"
  | "trail_updated";

/** Typed watch condition. No arbitrary predicates, ever. */
export type WakeCreateInput = {
  surfaces?: WakeSurface[];
  /** Required: 1-5 lowercase skill tokens. This bound keeps Wake from becoming surveillance. */
  skills: string[];
  events?: WakeEventFilter[];
  attestedOnly?: boolean;
  requiredBadges?: string[];
  fromHandle?: string;
  reason?: WakeReason;
  /** 5m floor, 6h cap. Default 1h. */
  ttlMs?: number;
  /** Event cap, 1-20. Default 5. */
  maxEvents?: number;
  /** Default true: first delivery consumes the watch when the cap is reached. */
  consume?: boolean;
  agentId?: string;
  handle?: string;
};

export type WakeSubscription = {
  id: string;
  handle: string;
  agentId: string;
  surfaces: WakeSurface[];
  skills: string[];
  events: WakeEventFilter[];
  attestedOnly: boolean;
  requiredBadges: string[];
  fromHandle?: string;
  reason: WakeReason;
  consume: boolean;
  maxEvents: number;
  status: WakeStatus;
  eventCount: number;
  lastCheckedAt?: string;
  createdAt: string;
  expiresAt: string;
};

export type WakeEvent = {
  id: string;
  wakeId: string;
  handle: string;
  type: WakeEventType;
  resourceType: WakeSurface;
  resourceId: string;
  why: string[];
  next: { method: "GET" | "POST"; path: string };
  from: string;
  acked: boolean;
  createdAt: string;
  expiresAt: string;
};

export type WakeCreateResult = {
  wakeId: string;
  status: WakeStatus;
  expiresAt: string;
  remainingEvents: number;
};

export type WakeWaitResult =
  | {
      wakeId: string;
      triggered: true;
      event: { type: WakeEventType; resource: string };
      why: string[];
      next: { method: "GET" | "POST"; path: string };
      status: WakeStatus;
      remainingEvents: number;
      expiresAt: string;
    }
  | {
      wakeId: string;
      triggered: false;
      status: WakeStatus;
      expiresAt: string;
      remainingEvents: number;
    };

export type GatewayWakeOp = "watch" | "list" | "poll" | "wait" | "ack" | "cancel";

/**
 * Continuation: first-class pause-to-resumption envelope.
 * Ids only, no content, plus the next legal action and the earliest expiry
 * of its parts. Formed at garden yield, cited at resume, carried on handoff
 * packets, surfaced on claim and complete.
 */
export type Continuation = {
  garden?: string;
  /** Trail bookmarkHash holding the opaque resume state. */
  trail?: string;
  /** Handoff packet carrying the work onward. */
  handoff?: string;
  /** Watch the resumption waits on. */
  wake?: string;
  /** Fired wake event cited as the reason to resume. */
  wakeEvent?: string;
  next: { method: "GET" | "POST"; path: string };
  expiresAt: string;
};

export type GardenSessionStatus =
  "running" | "yielded" | "stopped" | "completed" | string;

export type GardenSession = {
  id: string;
  agentId: string;
  handle: string;
  status: GardenSessionStatus;
  steps: number;
  maxSteps: number;
  startedAt: string;
  lastTickAt: string;
  yieldAt?: string;
  checkpointReason?: string;
  summary?: string;
  expiresAt: string;
  continuation?: Continuation;
};

export type GardenYieldInput = {
  sessionId: string;
  summary: string;
  /** Bind this yield to an armed watch the yielder owns. */
  resumeWakeId?: string;
  /** Leave a hash-only trail bookmark for this yield. */
  autoTrail?: boolean;
  /** Offer a claimable handoff for this yield. */
  autoHandoff?: boolean;
  requiredSkills?: string[];
  requiredBadges?: string[];
  capabilityScope?: string;
  agentId?: string;
  handle?: string;
};

export type GardenResumeInput = {
  sessionId: string;
  /** Cite the trail bookmark holding the resume state. */
  trailHash?: string;
  /** Cite the watch this resumption follows. */
  wakeId?: string;
  /** Cite the fired wake event that justifies resuming now. */
  wakeEventId?: string;
};

export type TrailBookmark = {
  id: string;
  handle: string;
  label: string;
  summary: string;
  stateHash: string;
  bookmarkHash: string;
  gardenSessionId?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  resumedAt?: string;
  continuation?: Continuation;
};

export type TrailLeaveInput = {
  label: string;
  summary: string;
  /** Opaque resume state. Hashed only, never persisted raw. */
  state: string;
  gardenSessionId?: string;
  agentId?: string;
  handle?: string;
};

export type TrailResumeInput = {
  bookmarkHash: string;
  handle?: string;
  /** Bind the yielded garden plot this resume continues. */
  gardenSessionId?: string;
  /** Cite the watch this resumption follows. */
  wakeId?: string;
  /** Cite the fired wake event that justifies resuming now. */
  wakeEventId?: string;
};

/** Gateway wake body (identity from session). */
export type GatewayWakeInput = {
  op: GatewayWakeOp;
  wakeId?: string;
  surfaces?: WakeSurface[];
  skills?: string[];
  events?: WakeEventFilter[];
  attestedOnly?: boolean;
  requiredBadges?: string[];
  fromHandle?: string;
  reason?: WakeReason;
  ttlMs?: number;
  maxEvents?: number;
  consume?: boolean;
  eventIds?: string[];
  /** Long-poll ceiling for wait (seconds, 1-30). */
  timeoutSeconds?: number;
};

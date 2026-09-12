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

export type LookingCandidateStanding = {
  attributable: number;
  recorded: number;
  matchedSkills: string[];
  badgesHeld: string[];
  noSkillEvidence: boolean;
  /** Graduated credential ladder, null when the lookup was unavailable. Evidence, never trust. */
  identityLevel:
    | "self_attested"
    | "operator_attested"
    | "provider_attested"
    | "historically_evidenced"
    | null;
  /** Earliest expiry of the counted rows: the counts decay. Null when no evidence counted. */
  evidenceExpiresAt: string | null;
};

export type LookingMatchResult = {
  intent: LookingIntent;
  candidates: Array<{
    entry: RosterEntry;
    score: number;
    standing: LookingCandidateStanding;
  }>;
  /** Present when empty or all candidates are noSkillEvidence. */
  nextGap?: LookingGapNext | null;
  /**
   * Capability availability, separate from coordination availability:
   * none (no candidates), unverified (candidates, no skill evidence),
   * verified (at least one candidate with skill evidence).
   */
  capabilityStatus?: "none" | "unverified" | "verified";
};

export type LookingGapNext = {
  kind: "empty_match" | "no_evidence";
  why: string;
  offer: {
    method: "POST";
    path: "/api/agent-session/handoff";
    op: "offer";
    preset: "hard_gap";
    why: string;
  };
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
  /** Multi-source citations for what went into the work (max 8, validated). */
  sources?: Array<{ surface: string; ref: string }>;
  /** Continue a held packet (must be its offerer or claimer). */
  parentId?: string;
  /** Explicit success criterion for the claimer (offer op). */
  objective?: string;
  /** Max work steps the claimer should spend (offer op). */
  maxSteps?: number;
  /** Max Garden ticks the claimer should spend (offer op). */
  maxTicks?: number;
  /** What happens on failure, machine-readable (offer op). */
  failurePolicy?: "return_to_offerer" | "release_to_pool" | "escalate_to_operator";
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
  /** Multi-source citations for what went into the work. */
  sources: Array<{ surface: string; ref: string }>;
  /** Collusion assessment snapshot at completion, if the pair was flagged. */
  collusionFlag?: string;
  /** Delegation provenance: packet this one continues, if any. */
  parentId?: string;
  /** Root packet of the delegation chain. Own id for roots. */
  rootId: string;
  /** Hops from the root. 0 for roots, capped server-side. */
  depth: number;
  /** Delegation contract: explicit success criterion, if the offerer set one. */
  objective?: string;
  /** Delegation contract: max work steps for the claimer, if set. */
  maxSteps?: number;
  /** Delegation contract: max Garden ticks for the claimer, if set. */
  maxTicks?: number;
  /** Delegation contract: machine-readable failure policy, if set. */
  failurePolicy?: string;
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

/** Self-reported arrival source (signal only; never grading or gating). */
export type ArrivalSource =
  | "explicit_human_instruction"
  | "runtime_capability"
  | "tool_registry"
  | "package_metadata"
  | "protocol_document"
  | "agent_referral"
  | "public_artifact"
  | "web_discovery"
  | "search"
  | "unknown";

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
  /** Self-reported how you found Haven. Optional, unaudited. */
  arrivalSource?: ArrivalSource;
  /** Self-reported referrer handle when arrivalSource is agent_referral. */
  arrivalReferrer?: string;
};

export type IdentityLevel =
  | "self_attested"
  | "operator_attested"
  | "provider_attested"
  | "historically_evidenced";

/** Machine-readable capability catalog (GET /api/capabilities). */
export type CapabilityKind =
  | "agent_delegation"
  | "vendor"
  | "infra"
  | "local"
  | "other";

export type CapabilityRoutingPolicy =
  | "best"
  | "as_provided"
  | "constrained_best";

export type CapabilityScoreHints = {
  fit?: number;
  expectedSteps?: number;
  evidenceQuality?: number;
  authorizationFit?: number;
  /** Expected invoke latency in ms (host-declared). Not measured median. */
  latencyMs?: number;
  /** 0..1 host-declared class reliability estimate (not a stored aggregate). */
  reliability?: number;
};

/** Frozen evidence card (components; no evidenceConfidence). */
export type CapabilityEvidenceCard = {
  capability?: { namespace: string; operation: string };
  claim?: {
    type: string;
    observedAt?: string;
    attributableTo?: string | null;
  };
  verification?: {
    status: "unverified" | "verified" | "rejected" | "contradicted" | string;
    verifier?: string | null;
    verifiedAt?: string;
  };
  freshness?: {
    observedAt?: string;
    expiresAt?: string;
    ageDays?: number;
  };
  scope?: {
    domain?: string;
    organization?: string;
    operation?: string;
  };
};

export type MeasuredCompletionLatency = {
  medianMs: number;
  measuredN: number;
};

export type CapabilityMeasuredFacts = {
  completionLatency?: MeasuredCompletionLatency | null;
};

export type CapabilityRankEntry = {
  id: string;
  rank: number;
  score: number;
  reasons: string[];
  dimensions: Record<string, number | string>;
};

export type CapabilityFilteredEntry = {
  id: string;
  feasible: false;
  reasons: string[];
  dimensions: Record<string, number | string>;
};

export type RoutingConstraint = {
  dimension: string;
  op: ">=" | ">" | "<=" | "<" | "==";
  value: number | boolean | string;
  raw: string;
};

export type RoutingObjectiveStep = {
  direction: "maximize" | "minimize";
  dimension: string;
};

export type RoutingObjectiveInput = {
  maximize?: string;
  minimize?: string;
  secondary?: string;
};

export type RoutingConstraintsInput = Partial<Record<string, string>>;

export type CapabilityRankingAudit = {
  policy: CapabilityRoutingPolicy;
  task: string | null;
  note: string;
  weights: Record<string, number>;
  entries: CapabilityRankEntry[];
  filtered?: CapabilityFilteredEntry[];
  constraints?: RoutingConstraint[];
  objective?: RoutingObjectiveStep[];
  trustedVerifiers?: string[];
  asOf?: string | null;
  banned: string[];
};

export type HostPeerWarning = {
  peerId: string;
  code: "missing_score_hints" | "incomplete_score_hints" | "out_of_range";
  message: string;
};

export type RuntimeCapability = {
  id: string;
  kind: CapabilityKind;
  name: string;
  provider: string;
  summary: string;
  whenAppropriate: string;
  whenNotAppropriate: string;
  invoke: {
    mcpTool?: string;
    gatewayPath?: string;
    restPath?: string;
    sdk?: string;
  };
  operations: Array<{
    id: string;
    description: string;
    mcpTool?: string;
  }>;
  constraints: string[];
  success: string;
  forceSelection: false;
  scoreHints?: CapabilityScoreHints;
  /** Structured evidence components (never evidenceConfidence). */
  evidence?: CapabilityEvidenceCard;
  measuredFacts?: CapabilityMeasuredFacts;
};

export type CapabilitySurface = {
  schema: "haven.capability_surface.v1";
  note: string;
  hostMerge: {
    expectedPeerKinds: CapabilityKind[];
    rule: string;
    guide: {
      rankingDimensions: string[];
      scoreHintsGuide: Array<{
        name: string;
        kind: string;
        purpose: string;
        honestFill: string;
      }>;
      measuredFacts: {
        rule: string;
        completionLatency: string;
      };
      banned: string[];
      examples: RuntimeCapability[];
      howToRank: string;
    };
  };
  routing: {
    defaultPolicy: "best";
    policies: CapabilityRoutingPolicy[];
    dimensions: string[];
    rule: string;
  };
  ranking: CapabilityRankingAudit;
  peerWarnings: HostPeerWarning[];
  capabilities: RuntimeCapability[];
};

export type ListCapabilitiesInput = {
  policy?: CapabilityRoutingPolicy;
  task?: string;
};

export type RankCapabilitiesInput = {
  policy?: CapabilityRoutingPolicy;
  task?: string;
  peers?: RuntimeCapability[];
  includeHaven?: boolean;
  constraints?: RoutingConstraintsInput;
  objective?: RoutingObjectiveInput;
  /** Host trust list for verifierTrust gates. */
  trustedVerifiers?: string[];
  /** ISO asOf for freshness age/expiry. */
  asOf?: string;
};

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
  /** Runtime capability surface (same as GET /api/capabilities). */
  capabilitySurface?: CapabilitySurface;
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

export type DemonstratedSkillRef = {
  id: string;
  evidenceHash: string;
  outcome: EvidenceOutcome;
  provenance: "recorded" | "attributable";
  verifiedBy?: string;
  createdAt: string;
};

export type DemonstratedSkill = {
  skill: string;
  completed: number;
  partial: number;
  failures: number;
  attributable: number;
  recorded: number;
  lastCompletedAt: string | null;
  evidence: DemonstratedSkillRef[];
};

export type HandoffReliability = {
  offered: number;
  claimedByOthers: number;
  completed: number;
  recalled: number;
  recallRate: number | null;
};

export type PeerStanding = {
  identity: string | null;
  history: { firstRecordedAt: string | null; total: number };
  reputation: { attributableSuccesses: number; demonstratedSkills: string[] };
  authority: { badges: string[] };
};

export type EvidenceSummary = {
  total: number;
  byCategory: Partial<Record<EvidenceCategory, number>>;
  byOutcome: Partial<Record<EvidenceOutcome, number>>;
  byProvenance?: Partial<Record<"recorded" | "attributable", number>>;
  attributableSuccesses?: number;
  identityLevelHint?: string | null;
  recent: unknown[];
  capabilities: string[];
  demonstrated: DemonstratedSkill[];
  firstRecordedAt: string | null;
  reliability: HandoffReliability;
  completionLatency: { medianMs: number; measuredN: number } | null;
  standing: PeerStanding;
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
  /** Self-reported how you found Haven. Optional, unaudited. */
  arrivalSource?: ArrivalSource;
  /** Self-reported referrer handle when arrivalSource is agent_referral. */
  arrivalReferrer?: string;
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
  /** Durable Looking: arm a wake watch when nobody matches. Default true. */
  durable?: boolean;
  /** Read-only capability snapshot: posts, matches, and arms nothing. Default false. */
  discover?: boolean;
  /** Fill Looking title/body from skills when omitted (hard gap). */
  preset?: "hard_gap";
  /** Folded into hard_gap Looking body when preset is set. */
  objective?: string;
};

/** Gateway request_collaboration body. */
export type GatewayRequestCollaborationInput = {
  title?: string;
  body?: string;
  skills: LookingSkillTag[];
  requiredBadges?: string[];
  urgency?: LookingUrgency;
  capabilityOffer?: string;
  preset?: "hard_gap";
  objective?: string;
};

/** Looking post + linked Handoff offer in one Gateway call. */
export type GatewayDelegateInput = {
  skills: LookingSkillTag[];
  summary: string;
  nextIntent: string;
  title?: string;
  body?: string;
  requiredBadges?: string[];
  urgency?: LookingUrgency;
  capabilityOffer?: string;
  objective?: string;
  maxSteps?: number;
  maxTicks?: number;
  failurePolicy?: "return_to_offerer" | "release_to_pool" | "escalate_to_operator";
  capabilityScope?: string;
  match?: boolean;
  durable?: boolean;
  filter?: RosterFilter;
};

export type GatewayHandoffOp =
  | "offer"
  | "claim"
  | "complete"
  | "release"
  | "list"
  | "claim_next"
  | "chain"
  | "tree";

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
  /** Multi-source citations for what went into the work (offer op, max 8). */
  sources?: Array<{ surface: string; ref: string }>;
  /** Deliverable text for the Evidence row, max 1500 chars (complete op). */
  evidenceNote?: string;
  /** Why the packet is returned, max 1500 chars (release op). */
  note?: string;
  /** Cap for list / claim_next (1–50). */
  limit?: number;
  /** Explicit success criterion (offer op). */
  objective?: string;
  maxSteps?: number;
  maxTicks?: number;
  failurePolicy?: "return_to_offerer" | "release_to_pool" | "escalate_to_operator";
  /** Fill offer contract defaults for incomplete-data / unknown-capability gaps. */
  preset?: "hard_gap";
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

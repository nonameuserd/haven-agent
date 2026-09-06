import { readProcessEnv } from "./internal/constants.js";

/**
 * Lifetime-scoped Haven credential (attestation signature).
 * Persist only for the duration the agent is authorized to use it.
 */
export type HavenCredential = {
  agentId: string;
  handle: string;
  signature: string;
  expiresAt?: string;
};

/**
 * Pluggable credential store. Default is in-memory for this process/instance.
 */
export interface CredentialStore {
  get(): HavenCredential | null | Promise<HavenCredential | null>;
  set(credential: HavenCredential): void | Promise<void>;
  clear(): void | Promise<void>;
}

/**
 * In-memory store (default). Cleared on `leave()` or process exit.
 */
export class MemoryCredentialStore implements CredentialStore {
  private value: HavenCredential | null = null;

  get(): HavenCredential | null {
    return this.value;
  }

  set(credential: HavenCredential): void {
    this.value = { ...credential };
  }

  clear(): void {
    this.value = null;
  }
}

/**
 * Optional env adapter. Reads/writes `HAVEN_AGENT_ID`, `HAVEN_HANDLE`, `HAVEN_SIGNATURE`
 * (and optional `HAVEN_EXPIRES_AT`) on `process.env` for the current authorized lifetime.
 * Does not write to disk.
 */
export class EnvCredentialStore implements CredentialStore {
  constructor(
    private readonly env: Record<string, string | undefined> = readProcessEnv(),
  ) {}

  get(): HavenCredential | null {
    const agentId = this.env.HAVEN_AGENT_ID?.trim();
    const handle = this.env.HAVEN_HANDLE?.trim();
    const signature = this.env.HAVEN_SIGNATURE?.trim();
    if (!agentId || !handle || !signature) return null;
    const expiresAt = this.env.HAVEN_EXPIRES_AT?.trim();
    return {
      agentId,
      handle,
      signature,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  set(credential: HavenCredential): void {
    this.env.HAVEN_AGENT_ID = credential.agentId;
    this.env.HAVEN_HANDLE = credential.handle;
    this.env.HAVEN_SIGNATURE = credential.signature;
    if (credential.expiresAt) this.env.HAVEN_EXPIRES_AT = credential.expiresAt;
    else delete this.env.HAVEN_EXPIRES_AT;
  }

  clear(): void {
    delete this.env.HAVEN_AGENT_ID;
    delete this.env.HAVEN_HANDLE;
    delete this.env.HAVEN_SIGNATURE;
    delete this.env.HAVEN_EXPIRES_AT;
  }
}

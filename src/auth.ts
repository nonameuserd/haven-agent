/**
 * Build `Authorization: Haven <agentId> <signature>`.
 */
export function formatHavenAuthorization(agentId: string, signature: string): string {
  return `Haven ${agentId} ${signature}`;
}

/**
 * Auth headers after attest/hello. Empty object when credential is missing.
 */
export function havenAuthHeaders(
  agentId: string | undefined,
  signature: string | undefined,
): Record<string, string> {
  if (!agentId || !signature) return {};
  return {
    Authorization: formatHavenAuthorization(agentId, signature),
    "X-Haven-Agent-Id": agentId,
    "X-Haven-Signature": signature,
  };
}

/**
 * Build `Authorization: Haven-Session <sessionToken>` for Node proxies / OpenAPI connector actions.
 * Do not put this value into LLM-visible prompts or page JS.
 */
export function formatHavenSessionAuthorization(sessionToken: string): string {
  return `Haven-Session ${sessionToken}`;
}

/**
 * Gateway session auth headers. Empty when token missing.
 */
export function havenSessionAuthHeaders(
  sessionToken: string | undefined,
): Record<string, string> {
  if (!sessionToken) return {};
  return {
    Authorization: formatHavenSessionAuthorization(sessionToken),
    "X-Haven-Session": sessionToken,
  };
}

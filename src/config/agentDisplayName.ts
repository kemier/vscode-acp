/**
 * Name shown in the chat banner / status bar.
 *
 * Settings keys like "Pi Agent" are the label the user chose; they must win
 * over a generic adapter title ("pi ACP adapter"). Slug keys ("codex") still
 * use the agent's advertised title ("Codex CLI").
 */
export function resolveAgentDisplayName(
  agentName: string,
  opts?: {
    displayName?: string | null;
    agentInfo?: { title?: string | null; name?: string | null } | null;
  },
): string {
  const configured = opts?.displayName?.trim();
  if (configured) {
    return configured;
  }
  if (/[A-Z]/.test(agentName) || /\s/.test(agentName)) {
    return agentName;
  }
  const advertised = (opts?.agentInfo?.title || opts?.agentInfo?.name || '').trim();
  return advertised || agentName;
}

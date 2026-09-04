/**
 * Pure helpers for the `/session <name>` capture-and-restore flow.
 *
 * `/session <name>` summarizes another session and injects the summary into the
 * *current* session's context. To capture the target session's messages the
 * client performs a background `session/load`, which — when the target belongs
 * to a different agent than the active one — disconnects the active agent and
 * connects the target agent (see `SessionManager.loadSession`). The active
 * (agent, session) must be restored afterward so the model picker / config
 * options / chat state return to where the user was. Failing to do so is the
 * "cross-agent morph" bug: a `/session` lookup that matched a Kiro CLI session
 * would leave an Codex session's picker showing Kiro/Claude models.
 */

/**
 * The (agent, session) pair that was active before a capture, used as the
 * restore target after the capture completes.
 */
export interface CaptureRestoreTarget {
  agent: string;
  sessionId: string | null;
}

/**
 * Decide whether the active connection needs to be restored after a capture.
 *
 * Returns true when the post-capture active (agent, session) differs from the
 * original — including the case where a cross-agent load left a *truthy* foreign
 * session active (the prior restore was incorrectly skipped whenever
 * `currentActiveId` was truthy, which is exactly what left the picker morphed).
 *
 * Returns false when there was no original session to restore to (the caller
 * had no active session before the capture — nothing to restore), or when the
 * active connection is already back on the original pair.
 */
export function needsRestoreAfterCapture(
  original: CaptureRestoreTarget,
  postCaptureAgent: string | null,
  postCaptureSession: string | null,
): boolean {
  if (original.sessionId === null) {
    return false;
  }
  return postCaptureAgent !== original.agent || postCaptureSession !== original.sessionId;
}

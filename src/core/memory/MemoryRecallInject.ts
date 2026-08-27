/**
 * Recall inject helpers — keep SharedMemoryProvider merge logic testable.
 */

/** Omit skill-tools curl recipes when every enabled recall arm failed (gateway unreachable). */
export function resolveSkillToolsBlockForInject(
  skillToolsBlock: string | undefined,
  enabledArmResults: PromiseSettledResult<unknown>[],
): string | undefined {
  if (!skillToolsBlock?.trim()) {
    return undefined;
  }
  if (enabledArmResults.length === 0) {
    return skillToolsBlock;
  }
  const allEnabledArmsFailed = enabledArmResults.every((r) => r.status === 'rejected');
  return allEnabledArmsFailed ? undefined : skillToolsBlock;
}

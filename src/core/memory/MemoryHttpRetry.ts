/**
 * Transient network error detection for memory gateway HTTP retries.
 */

const RETRYABLE_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True for LAN blips / gateway warmup — not for timeouts or business errors. */
export function isRetryableMemoryFetchError(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  if (e.name === 'AbortError') {
    return false;
  }
  if (e.message.toLowerCase().includes('fetch failed')) {
    return true;
  }
  const cause = e.cause as { code?: string } | undefined;
  if (cause?.code && RETRYABLE_ERRNO.has(cause.code)) {
    return true;
  }
  if (e.name === 'MemoryHttpError') {
    const code = (e as Error & { code?: number }).code;
    return code === 502 || code === 503 || code === 504;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

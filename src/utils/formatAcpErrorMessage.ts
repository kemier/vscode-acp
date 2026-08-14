/**
 * Format an ACP / JSON-RPC failure for the chat panel or toasts.
 * Agents often put the actionable text in `error.data.details` while
 * `error.message` is a generic "Internal error" — prefer details when present.
 */
export function formatAcpErrorMessage(error: unknown, fallback = 'Error'): string {
  const errMsg = error instanceof Error ? error.message : error != null && error !== '' ? String(error) : '';
  const errData = (error as { data?: unknown } | null | undefined)?.data;
  let detail = '';
  if (typeof errData === 'string') {
    detail = errData;
  } else if (errData && typeof errData === 'object') {
    const details = (errData as { details?: unknown }).details;
    detail = typeof details === 'string' ? details : JSON.stringify(errData);
  }
  if (errMsg && detail) {
    return `${errMsg}: ${detail}`;
  }
  return errMsg || detail || fallback;
}

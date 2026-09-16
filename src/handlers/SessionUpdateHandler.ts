import { log } from '../utils/Logger';
import { SupersededTurnFilter } from './SupersededTurnFilter';

import type { SessionNotification } from '@agentclientprotocol/sdk';

export type SessionUpdateListener = (update: SessionNotification) => void;

/**
 * Routes session/update notifications to registered listeners.
 * The ChatWebviewProvider registers as a listener to forward updates to the webview.
 */
export class SessionUpdateHandler {
  private listeners: Set<SessionUpdateListener> = new Set();
  /**
   * Drops frames from a turn that a newer turn has replaced.
   *
   * This is the single choke point every session/update passes through, which is why the
   * gate lives here rather than in the webview: by the time a frame reaches the webview it
   * has already been turned into DOM, and the ordering damage is done. See
   * SupersededTurnFilter for the failure it prevents.
   */
  private readonly supersededFilter = new SupersededTurnFilter();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    const sessionId = String((update as { sessionId?: unknown })?.sessionId ?? '');
    if (this.supersededFilter.shouldDrop(sessionId, update as never)) {
      const kind = String((update as { update?: { sessionUpdate?: unknown } })?.update?.sessionUpdate ?? '?');
      log(
        `Dropped ${kind} from superseded turn ` +
          `(frame turn is older than ${this.supersededFilter.newestTurnFor(sessionId)}) — ` +
          'the previous turn is still emitting after being replaced',
      );
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        log(`Error in session update listener: ${e}`);
      }
    }
  }

  /** Forget a session's turn high-water mark (session deleted / disconnected). */
  forgetSession(sessionId: string): void {
    this.supersededFilter.forget(sessionId);
  }

  dispose(): void {
    this.listeners.clear();
    this.supersededFilter.reset();
  }
}

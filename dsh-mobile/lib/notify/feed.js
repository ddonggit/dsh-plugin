/**
 * Event feed: a tiny in-memory ring buffer of delivered notifications.
 *
 * Two consumers:
 *   - the browser half, which catches up on events it slept through (authenticated
 *     /api/dsh-mobile/feed route);
 *   - an optional desktop helper, which polls the keyed public route.
 *
 * `bootId` changes with the process, so a client that remembers a `seq` from a
 * previous run resets instead of waiting for numbers that will never appear.
 */

import { randomBytes } from 'node:crypto';

const CAPACITY = 50;
const TTL_MS = 10 * 60 * 1000;

export function createFeed() {
  const bootId = randomBytes(9).toString('base64url');
  const items = [];
  let seq = 0;

  const prune = (now) => {
    while (items.length > 0 && (now - items[0].at > TTL_MS || items.length > CAPACITY)) items.shift();
  };

  return {
    bootId,
    get seq() {
      return seq;
    },
    push(entry) {
      const now = Date.now();
      seq += 1;
      items.push({
        seq,
        at: now,
        kind: entry.kind,
        sessionId: entry.sessionId ?? '',
        title: entry.title,
        summary: entry.summary ?? '',
        body: entry.body,
        link: entry.link ?? '',
      });
      prune(now);
      return seq;
    },
    /** Entries newer than `since`; a stale `since` yields the whole buffer. */
    since(value) {
      const now = Date.now();
      prune(now);
      const from = Number.isFinite(value) ? value : 0;
      return items.filter((item) => item.seq > from);
    },
    latest() {
      return seq;
    },
  };
}

'use strict';

/**
 * Sliding window rate limiter.
 *
 * A public proxy attracts abuse, so every visitor gets a budget of requests
 * per minute. The buckets live in memory and expire on their own.
 */

class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.windowMs  window length in ms
   * @param {number} options.max       requests allowed per window
   * @param {number} options.maxKeys   maximum number of tracked keys
   */
  constructor({ windowMs = 60_000, max = 120, maxKeys = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // key -> number[]
    this.lastSweep = Date.now();
  }

  /**
   * Register a request.
   * @returns {{allowed: boolean, remaining: number, retryAfter: number}}
   */
  check(key, now = Date.now()) {
    if (this.max <= 0) return { allowed: true, remaining: Infinity, retryAfter: 0 };

    if (now - this.lastSweep > this.windowMs) {
      this.sweep(now);
    }

    let hits = this.buckets.get(key);
    if (!hits) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now, true);
      hits = [];
      this.buckets.set(key, hits);
    }

    const cutoff = now - this.windowMs;
    while (hits.length && hits[0] <= cutoff) hits.shift();

    if (hits.length >= this.max) {
      const retryAfter = Math.ceil((hits[0] + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    hits.push(now);
    return { allowed: true, remaining: this.max - hits.length, retryAfter: 0 };
  }

  /** Drop buckets that are no longer relevant. */
  sweep(now = Date.now(), force = false) {
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, hits] of this.buckets) {
      if (!hits.length || hits[hits.length - 1] <= cutoff) this.buckets.delete(key);
    }
    // Hard cap: drop the oldest buckets if we are still over the limit.
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      this.buckets.delete(oldest);
    }
    void force;
  }

  get size() {
    return this.buckets.size;
  }
}

/**
 * Limits how many proxied requests may run at the same time. Keeps a small
 * instance from being overwhelmed by slow upstream connections.
 */
class ConcurrencyLimiter {
  constructor(max = 64) {
    this.max = max;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }

  release() {
    if (this.active > 0) this.active--;
  }
}

module.exports = { RateLimiter, ConcurrencyLimiter };

import { Key } from "./index";

/**
 * Given a list of keys, returns a new list of keys sorted from highest to
 * lowest priority.  Keys are prioritized in the following order:
 *
 * 1. Keys which are not rate limited
 *    a. If all keys were rate limited recently, select the least-recently
 *       rate limited key.
 *    b. Otherwise, select the first key.
 * 2. Keys which have not been used in the longest time
 * 3. Keys according to the custom comparator, if provided
 * @param keys The list of keys to sort
 * @param customComparator A custom comparator function to use for sorting
 */
export function prioritizeKeys<T extends Key>(
  keys: T[],
  customComparator?: (a: T, b: T) => number
) {
  const now = Date.now();

  return keys.sort((a, b) => {
    const aRateLimited = now - a.rateLimitedAt < a.rateLimitedUntil;
    const bRateLimited = now - b.rateLimitedAt < b.rateLimitedUntil;

    if (aRateLimited && !bRateLimited) return 1;
    if (!aRateLimited && bRateLimited) return -1;
    if (aRateLimited && bRateLimited) {
      return a.rateLimitedAt - b.rateLimitedAt;
    }

    if (customComparator) {
      const result = customComparator(a, b);
      if (result !== 0) return result;
    }

    return a.lastUsed - b.lastUsed;
  });
}

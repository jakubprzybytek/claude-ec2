// The costs answer kept in this browser: Cost Explorer charges $0.01 a request and its data changes a few times a day,
// and the API function's own memory rarely outlives a few idle minutes, so the page itself avoids asking again.

import type { CostsAnswer } from "./api.ts";
import type { Cached } from "./usePoll.ts";

/** Versioned: an answer saved by an older page, without fields the card now reads, is never used. */
export const COSTS_CACHE_KEY = "costs-v2";
export const COSTS_FRESH_MS = 6 * 3600_000;

/** A saved costs answer is used as is while it is complete, under COSTS_FRESH_MS old and of this month. */
export function costsFresh({ data, at }: Cached<CostsAnswer>, now: number) {
  if (!data || "unavailable" in data || !data.instance || data.app === undefined) return false;
  return now - at < COSTS_FRESH_MS && data.month === new Date(now).toISOString().slice(0, 7);
}

/** "14:05" today, "Mon 14:05" within a week, else "17 Nov 14:05". */
export function time(epochSeconds: number, now = Date.now()): string {
  const d = new Date(epochSeconds * 1000);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = (now - d.getTime()) / 86_400_000;
  if (new Date(now).toDateString() === d.toDateString()) return hm;
  if (Math.abs(days) < 6) return `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
}

/** "2h 05m", "12m", "now". */
export function duration(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function ago(epochSeconds: number, now = Date.now()): string {
  const s = Math.round(now / 1000 - epochSeconds);
  return s < 60 ? "just now" : `${duration(s)} ago`;
}

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export const shortPath = (p: string | null) => (p ?? "").replace(/^\/home\/ubuntu(?=\/|$)/, "~");

/** A session name from a title or folder: letters, digits, - and _. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

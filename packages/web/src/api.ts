import { accessToken, logout } from "./auth.ts";

// Absolute (sst dev: API Gateway URL) or relative ("/api" behind the Router on the custom domain).
const API_URL: string = ((import.meta.env["VITE_API_URL"] as string | undefined) ?? "/api").replace(/\/$/, "");
export const APP_VERSION: string = (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "dev";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API_URL + path, { method, headers, cache: "no-store", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 401) {
    // Token missing, expired or revoked: back to the login form.
    await logout();
    window.location.reload();
    throw new ApiError(401, "Session expired. Sign in again.");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

// Shapes of the API's answers (packages/api/src/handler.ts, remote/*.sh).

export interface Instance {
  id: string;
  state: string;
  type: string;
  zone: string;
  publicIp: string | null;
  launchTime: string | null;
}

export interface Status {
  instance: Instance;
  ssmOnline: boolean;
  instanceTypes: string[];
}

export interface Details {
  now: number;
  bootTime: number;
  load: number[];
  memory: { total: number; available: number };
  disk: { total: number; used: number };
  claude: { running: boolean; clients: number; spawned: number };
  /** Missing from an instance whose status.sh predates it. */
  auth?: Auth;
  autostop:
    | { installed: false }
    | {
        installed: true;
        idleMinutes: number;
        maxUptimeHours: number;
        graceMinutes: number;
        lastActivity: number | null;
        snoozedUntil: number | null;
        shutdownScheduled: boolean;
        stopsAt: number;
        reason: string;
        estimate?: boolean;
      };
}

/** Claude Code's login on the instance (remote/status.sh); loggedIn null when `claude auth status` failed. */
export interface Auth {
  loggedIn: boolean | null;
  method?: string | null;
  /** Epoch seconds. */
  expiresAt?: number | null;
  loginInProgress?: boolean;
  error?: string;
}

export interface Session {
  name: string;
  main: boolean;
  created: number;
  lastActivity: number;
  attached: number;
  folder: string;
  state: string;
  conversation: string | null;
  url: string | null;
}

export interface Conversation {
  id: string;
  modified: number;
  size: number;
  folder: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  url: string | null;
}

export interface CommandResult {
  commandId: string;
  status: string;
  done: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** GET /costs (packages/api/src/costs.ts): the AWS account's costs this month, or why they are not available. */
export type CostsAnswer = Costs | { unavailable: string };

export interface Costs {
  month: string;
  currency: string;
  /** The Claude Code instance's costs month to date. */
  total: number;
  /** Running time, disk, public IPv4; largest first. */
  parts: { name: string; amount: number }[];
  days: { date: string; amount: number; estimated: boolean }[];
  updatedAt: number;
}

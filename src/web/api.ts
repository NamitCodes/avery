export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** True when we don't know whether the server processed the request. */
  get isNetwork() {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }
}

const TIMEOUT_MS = 15_000;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON (e.g. proxy error page).
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'SERVER_ERROR',
      e?.message ?? 'Something went wrong. Please try again.',
      (e ?? {}) as Record<string, unknown>,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
};

export function qs(params: Record<string, string | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}

// ---- Shared types -----------------------------------------------------------

export type Role = 'VOLUNTEER' | 'ADMIN' | 'EVENT_ADMIN' | 'EXCEPTION_DESK' | 'GATE_OPERATOR';
export const EVENT_MANAGERS: Role[] = ['ADMIN', 'EVENT_ADMIN'];
export const DESK_STAFF: Role[] = [...EVENT_MANAGERS, 'EXCEPTION_DESK'];
export const GATE_STAFF: Role[] = [...DESK_STAFF, 'GATE_OPERATOR'];
export const ROLE_LABEL: Record<Role, string> = {
  VOLUNTEER: 'Volunteer',
  ADMIN: 'Administrator',
  EVENT_ADMIN: 'Event administrator',
  EXCEPTION_DESK: 'Exception desk',
  GATE_OPERATOR: 'Gate operator',
};
export interface User {
  id: string;
  volunteer_code: string;
  name: string;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
}

export type SessionStatus = 'DRAFT' | 'SCHEDULED' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'ARCHIVED';

export interface Session {
  id: string;
  location_id: string;
  title: string;
  description: string;
  start_at: string;
  end_at: string;
  checkin_opens_at: string;
  checkin_closes_at: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

export interface SessionListItem extends Session {
  location_name: string;
  timezone: string;
  attendance_count: number;
}

export interface QrCode {
  id: string;
  location_id: string;
  public_identifier: string;
  status: 'ACTIVE' | 'REVOKED';
  created_at: string;
  revoked_at: string | null;
  url: string;
}

export interface Location {
  id: string;
  name: string;
  address: string;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  active_qr: QrCode | null;
  session_count?: number;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

/** Display helpers. All timestamps arrive as UTC ISO strings and are shown in the venue's time zone. */

const fmt = (tz: string | undefined, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts });

export const formatDateTime = (iso: string, tz?: string) =>
  fmt(tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatDate = (iso: string, tz?: string) =>
  fmt(tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

export const formatTime = (iso: string, tz?: string) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatTimeWithSeconds = (iso: string, tz?: string) =>
  fmt(tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso));

export function formatRange(startIso: string, endIso: string, tz?: string) {
  const sameDay = formatDate(startIso, tz) === formatDate(endIso, tz);
  return sameDay
    ? `${formatDate(startIso, tz)}, ${formatTime(startIso, tz)} – ${formatTime(endIso, tz)}`
    : `${formatDateTime(startIso, tz)} – ${formatDateTime(endIso, tz)}`;
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" in `tz`, for <input type="datetime-local">. */
export function toLocalInput(iso: string, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Today's date (YYYY-MM-DD) in the browser's zone. */
export function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  OPEN: 'Open',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  ARCHIVED: 'Archived',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  REVOKED: 'Revoked',
  VOIDED: 'Voided',
};

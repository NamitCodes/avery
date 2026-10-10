import { ApiError } from '../api';
import { formatTime } from '../format';
import type { AccessOutcome } from '../pages/events/types';
import { Button } from './fui';

export function errorOutcome(e: ApiError): AccessOutcome {
  return {
    result: 'REJECTED',
    code: e.code,
    message: e.message,
    event_type: 'ENTRY',
    access_event_id: '',
    occurred_at: new Date().toISOString(),
    replay: false,
    participant: null,
    gate: null,
  };
}

/** Large green/red gate result. */
export function ResultCard({
  outcome: o,
  tz,
  reentry,
  onIdCheck,
}: {
  outcome: AccessOutcome;
  tz?: string;
  reentry: boolean;
  onIdCheck(outcome: 'CHECKED' | 'FAILED'): void;
}) {
  const ok = o.result === 'ACCEPTED';
  const verdict = ok ? (o.event_type === 'EXIT' ? 'EXIT OK' : o.event_type === 'CHECK_IN' ? 'CHECKED IN' : 'ENTRY OK') : 'STOP';
  return (
    <div className={`gate-result ${ok ? 'ok' : 'bad'}`} role="status" aria-live="assertive">
      <div className="verdict">{verdict}</div>
      {o.participant && (
        <div className="who">
          {o.participant.name}
          <div style={{ fontSize: '1rem', fontWeight: 400, opacity: 0.9 }}>
            {o.participant.registration_reference}
            {o.participant.country && ` · ${o.participant.country}`}
          </div>
        </div>
      )}
      <div className="msg">{o.message}</div>
      {o.code === 'ALREADY_CHECKED_IN' && o.participant?.checked_in_at && (
        <div className="msg">Original check-in: {formatTime(o.participant.checked_in_at, tz)}</div>
      )}
      {ok && reentry && <div className="msg">Now: {o.participant?.current_access_state === 'INSIDE' ? 'INSIDE' : 'OUTSIDE'}</div>}
      {o.replay && <div className="msg small">(already processed — this is the original result)</div>}
      {o.code === 'ID_CHECK_REQUIRED' && o.participant && (
        <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
          <Button variant="subtle" onClick={() => onIdCheck('CHECKED')}>
            ID matches — admit
          </Button>
          <Button variant="subtle" onClick={() => onIdCheck('FAILED')}>
            ID does not match
          </Button>
        </div>
      )}
    </div>
  );
}

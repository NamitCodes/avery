import { formatRange } from '../format';
import type { Pass } from '../pages/events/types';

/** Print-friendly participant pass. Contains only an opaque QR, name, country and reference. */
export function PassCard({ pass }: { pass: Pass }) {
  const e = pass.event;
  return (
    <div className="pass" data-pass-url={pass.pass_url}>
      <div className="small muted">Entry pass</div>
      <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>{e.name}</div>
      <div className="small">{formatRange(e.starts_at, e.ends_at, e.timezone)}</div>
      {e.venue && <div className="small">{e.venue}</div>}
      <img src={pass.qr_data_url} alt="Entry QR code" />
      <div className="name">{pass.participant.name}</div>
      {pass.participant.country && <div>{pass.participant.country}</div>}
      <div className="ref">{pass.participant.registration_reference}</div>
      <div className="fine">
        <p>Bring this printed pass. A phone is not required.{e.reentry_enabled ? ' Keep it — you need it to exit and re-enter.' : ''}</p>
        {e.instructions && <p>{e.instructions}</p>}
        <p>
          Lost your pass? Go to the exception desk with your registration reference and photo ID. Don’t share this pass: anyone holding it
          can use it.
        </p>
      </div>
    </div>
  );
}

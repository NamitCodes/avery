import { Link, useParams } from 'react-router-dom';
import { api, type Location } from '../../api';
import { ErrorMessage, useLoad } from '../../components/ui';

/** Printable venue poster: QR, venue name and basic instructions. */
export function QrPrintPage() {
  const { qrId = '' } = useParams();
  const { data, error } = useLoad(async () => {
    const { locations } = await api.get<{ locations: Location[] }>('/admin/locations');
    return locations.find((l) => l.active_qr?.id === qrId) ?? null;
  }, [qrId]);

  if (error) return <ErrorMessage error={error} />;
  if (data === null) return <p className="muted center" style={{ marginTop: '3rem' }}>This QR code is not active.</p>;
  if (!data) return null;

  return (
    <div className="qr-sheet">
      <div className="no-print row" style={{ justifyContent: 'space-between', marginBottom: '2rem' }}>
        <Link to={`/admin/venues/${data.id}`}>← Back</Link>
        <button onClick={() => window.print()}>Print</button>
      </div>
      <p className="muted">Volunteer attendance</p>
      <h1>{data.name}</h1>
      <img src={`/api/admin/qr-codes/${qrId}/image?format=svg`} alt={`Attendance QR code for ${data.name}`} />
      <ol style={{ textAlign: 'left', maxWidth: 380, margin: '1.5rem auto 0', fontSize: '1.05rem' }}>
        <li>Scan this code with your phone camera.</li>
        <li>Sign in with your volunteer account.</li>
        <li>Choose your activity and tap “Confirm attendance”.</li>
      </ol>
      <p className="muted small" style={{ marginTop: '1.5rem' }}>
        No phone or problems checking in? Please ask an organiser.
      </p>
    </div>
  );
}

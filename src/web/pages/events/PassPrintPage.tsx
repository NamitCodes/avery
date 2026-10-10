import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, useLoad } from '../../components/ui';
import type { Pass } from './types';
import { Button } from '../../components/fui';

/** Desk reprint of the current pass (staff only; the action is audited server-side). */
export function PassPrintPage() {
  const { credentialId = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => api.get<{ pass: Pass }>(`/admin/event-credentials/${credentialId}/pass`), [credentialId]);
  return (
    <main>
      <div className="no-print row" style={{ justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <Button variant="subtle" onClick={() => navigate(-1)}>
          ← Back
        </Button>
        <Button variant="solid" onClick={() => window.print()} disabled={!data}>
          Print
        </Button>
      </div>
      <ErrorMessage error={error} />
      {data && <PassCard pass={data.pass} />}
    </main>
  );
}

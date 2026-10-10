import { useParams } from 'react-router-dom';
import { api } from '../../api';
import { PassCard } from '../../components/PassCard';
import { ErrorMessage, useLoad } from '../../components/ui';
import type { Pass } from '../events/types';

/** Printable pass for the holder of the link (the link itself is the bearer credential). */
export function PublicPassPage() {
  const { token = '' } = useParams();
  const { data, error } = useLoad(() => api.get<{ pass: Pass }>(`/public/passes/${encodeURIComponent(token)}`), [token]);
  return (
    <main>
      <ErrorMessage error={error} />
      {data && (
        <>
          <PassCard pass={data.pass} />
          <div className="actions no-print" style={{ justifyContent: 'center' }}>
            <button onClick={() => window.print()}>Print pass</button>
          </div>
        </>
      )}
    </main>
  );
}

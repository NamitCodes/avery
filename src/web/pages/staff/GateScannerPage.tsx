import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { errorOutcome, ResultCard } from '../../components/GateResult';
import { ErrorMessage, useLoad } from '../../components/ui';
import { newKey, type AccessOutcome } from '../events/types';

interface GateInfo {
  gate: { id: string; name: string; mode: 'ENTRY' | 'EXIT'; status: string };
  event: { id: string; name: string; status: string; reentry_enabled: boolean; id_check_mode: string; timezone: string };
  operator: { id: string; name: string };
}

type View =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'result'; outcome: AccessOutcome; scanned: string }
  | { kind: 'network'; scanned: string; key: string; error: ApiError };

// Minimal typing for the browser BarcodeDetector API (Chrome/Android).
interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/**
 * Gate scanning station. Works with USB/Bluetooth scanners (keyboard input +
 * Enter) and, where supported, the device camera. A result is shown only after
 * the server confirms it; on network failure the scan is NOT confirmed and can be
 * retried with the same idempotency key.
 */
export function GateScannerPage() {
  const { gateId = '' } = useParams();
  const info = useLoad(() => api.get<GateInfo>(`/staff/gates/${gateId}`), [gateId]);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [input, setInput] = useState('');
  const [camera, setCamera] = useState(false);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const submit = useCallback(
    async (scanned: string, key = newKey()) => {
      if (busy.current || !scanned.trim()) return;
      busy.current = true;
      setView({ kind: 'pending' });
      try {
        const outcome = await api.post<AccessOutcome>('/gate-scan', { gate_id: gateId, credential: scanned.trim(), idempotency_key: key });
        setView({ kind: 'result', outcome, scanned });
      } catch (err) {
        const e = err as ApiError;
        setView(e.isNetwork || e.status >= 500 ? { kind: 'network', scanned, key, error: e } : { kind: 'result', outcome: errorOutcome(e), scanned });
      } finally {
        busy.current = false;
        setInput('');
        inputRef.current?.focus();
      }
    },
    [gateId],
  );

  // Camera scanning (optional).
  useEffect(() => {
    if (!camera || !window.BarcodeDetector) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let last = '';
    let lastAt = 0;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      while (!stopped) {
        try {
          const codes = await detector.detect(videoRef.current);
          const value = codes[0]?.rawValue;
          // Ignore the same code held in front of the camera for a few seconds.
          if (value && !busy.current && (value !== last || Date.now() - lastAt > 4000)) {
            last = value;
            lastAt = Date.now();
            await submit(value);
          }
        } catch {
          // frame not ready
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })().catch(() => setCamera(false));
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camera, submit]);

  if (info.error) {
    return (
      <main className="narrow">
        <ErrorMessage error={info.error} />
        <Link to="/staff">← Stations</Link>
      </main>
    );
  }
  if (!info.data) return <p className="muted center">Loading station…</p>;
  const { gate, event, operator } = info.data;
  const tz = event.timezone;

  async function recordId(outcome: 'CHECKED' | 'FAILED', participantId: string, rescan: string) {
    try {
      await api.post(`/admin/events/${event.id}/participants/${participantId}/verify-identity`, { outcome });
      if (outcome === 'CHECKED') await submit(rescan);
      else setView({ kind: 'idle' });
    } catch (err) {
      setView({ kind: 'result', outcome: errorOutcome(err as ApiError), scanned: rescan });
    }
  }

  return (
    <div className="gate">
      <div className="gate-head">
        <div>
          <div className="small muted">{event.name}</div>
          <strong style={{ fontSize: '1.2rem' }}>{gate.name}</strong>
          <div className="small muted">Operator: {operator.name}</div>
        </div>
        <div className="gate-mode" aria-label={`Mode ${gate.mode}`}>
          {event.reentry_enabled ? gate.mode : 'CHECK-IN'}
        </div>
        <Link to="/staff" className="small">
          Exit station
        </Link>
      </div>
      {(event.status !== 'ACTIVE' || gate.status !== 'ACTIVE') && (
        <div className="alert alert-error" style={{ margin: '1rem' }}>
          This {event.status !== 'ACTIVE' ? 'event' : 'gate'} is not active. Scans will be rejected.
        </div>
      )}
      <div className="gate-body">
        <form
          className="no-print"
          style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input);
          }}
        >
          <input
            ref={inputRef}
            className="gate-input"
            autoFocus
            autoComplete="off"
            placeholder="Scan pass…"
            value={input}
            disabled={view.kind === 'pending'}
            onChange={(e) => setInput(e.target.value)}
            onBlur={() => setTimeout(() => inputRef.current?.focus(), 50)}
          />
        </form>

        {view.kind === 'idle' && <p className="muted">Ready. Scan the QR code on the participant’s printed pass.</p>}
        {view.kind === 'pending' && (
          <div className="gate-result pending">
            <div className="verdict">Checking…</div>
          </div>
        )}
        {view.kind === 'network' && (
          <div className="gate-result unknown" role="alert">
            <div className="verdict">NOT CONFIRMED</div>
            <div className="msg">Could not reach the server. Do not admit yet.</div>
            <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
              <button className="btn-secondary" onClick={() => submit(view.scanned, view.key)}>
                Retry this scan
              </button>
              <button className="btn-secondary" onClick={() => setView({ kind: 'idle' })}>
                Dismiss — send to exception desk
              </button>
            </div>
          </div>
        )}
        {view.kind === 'result' && <ResultCard outcome={view.outcome} tz={tz} reentry={event.reentry_enabled} onIdCheck={(o) => view.outcome.participant && recordId(o, view.outcome.participant.id, view.scanned)} />}

        {window.BarcodeDetector && (
          <div className="no-print">
            <button className="btn-secondary btn-sm" onClick={() => setCamera(!camera)}>
              {camera ? 'Stop camera' : 'Use camera'}
            </button>
            {camera && <video ref={videoRef} muted playsInline style={{ display: 'block', width: 320, maxWidth: '100%', marginTop: '0.75rem', borderRadius: 6 }} />}
          </div>
        )}
      </div>
    </div>
  );
}

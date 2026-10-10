import { Link } from 'react-router-dom';
import { PhoneReachability, ResetDemoButton } from '../../components/demoKit';
import { useDemo } from '../../demoInfo';

const DEMOS = [
  {
    to: '/demo/weekly',
    title: 'Weekly check-in',
    blurb: 'Regular volunteering at a venue with a printed QR.',
    steps: ['Laptop creates today’s session', 'Venue QR on screen', 'Phone signs in as a volunteer and scans', 'Laptop shows the check-in live'],
  },
  {
    to: '/demo/planned',
    title: 'Planned visits',
    blurb: 'Pre-registered visitors with printed passes; participant and event-volunteer entry & exit gates.',
    steps: ['Phone becomes a gate scanner', 'Laptop adds a participant and shows the pass', 'Phone scans: entry, exit, re-entry', 'Laptop shows who is inside'],
  },
  {
    to: '/demo/surprise',
    title: 'Surprise visits',
    blurb: 'Science of the Soul, Amber Road — register online without an account, or just walk in.',
    steps: ['Registration QR on screen', 'Phone registers as a visitor', 'Laptop checks them in', 'Walk-in without a phone'],
  },
];

export function DemoIndexPage() {
  const demo = useDemo();
  return (
    <>
      <h1>Demos</h1>
      <p className="lead">
        Three short demos, one per use case. Each needs <strong>this laptop</strong> (on a projector) and <strong>one phone</strong>. The laptop signs in as the demo
        administrator automatically.
      </p>
      {demo?.seeded && <PhoneReachability demo={demo} />}
      <div className="demo-cards">
        {DEMOS.map((d) => (
          <Link key={d.to} to={d.to} className="card demo-card">
            <h2>{d.title}</h2>
            <p className="muted">{d.blurb}</p>
            <ol className="small">
              {d.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <span className="btn">Start</span>
          </Link>
        ))}
      </div>
      <div className="card demo-full">
        <div>
          <h2 style={{ margin: 0 }}>Detailed demo guide</h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Every feature, step by step: imports with errors, corrections & audit, revoking QR codes, lost passes, ID checks, email verification, exception desk,
            exports, sample passes and the email outbox.
          </p>
        </div>
        <Link className="btn btn-secondary" to="/demo/full">
          Open detailed guide
        </Link>
      </div>
      {demo?.seeded && (
        <div className="card demo-full">
          <div>
            <h2 style={{ margin: 0 }}>Start fresh</h2>
            <p className="muted" style={{ margin: '0.25rem 0 0' }}>
              Undo everything done in earlier demos and reload the original demo data. Signs this laptop in as the demo administrator.
            </p>
          </div>
          <ResetDemoButton />
        </div>
      )}
      <p className="small muted" style={{ marginTop: '1.5rem' }}>
        Demo accounts all use the password <code className="mono">{demo?.seeded ? demo.password : 'demo1234'}</code>; the sign-in page lists them for one-tap login on
        phones.
      </p>
    </>
  );
}

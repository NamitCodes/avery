import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL, type Role, type User } from '../api';
import { useAuth } from '../auth';
import { ErrorMessage } from '../components/ui';
import { loadDemo, type DemoInfo } from '../demoInfo';
import { formatDateTime } from '../format';

interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
  sent_at: string;
}

/**
 * Presenter's guide for demos (DEMO_MODE only). Every step says what to click
 * and what to point out; "Sign in as …" buttons switch accounts in one click.
 */
export function DemoPage() {
  const [demo, setDemo] = useState<DemoInfo | null | undefined>(undefined);
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void loadDemo(true).then(setDemo);
  }, []);

  /** Sign in as a demo account, then (optionally) open a page. */
  const signInAs = useCallback(
    async (key: string, to?: string) => {
      if (!demo) return;
      const acct = demo.accounts.find((a) => a.key === key)!;
      setError(null);
      try {
        if (user?.email !== acct.email) {
          await api.post('/auth/logout');
          const res = await api.post<{ user: User }>('/auth/login', { email: acct.email, password: demo.password });
          setUser(res.user);
        }
        if (to) navigate(to);
        else setNotice(`Signed in as ${acct.name}.`);
      } catch (err) {
        setError(err);
      }
    },
    [demo, user, setUser, navigate],
  );

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  if (demo === undefined) return <p className="muted">Loading demo guide…</p>;
  if (demo === null) {
    return (
      <>
        <h1>Demo guide</h1>
        <p className="muted">
          Demo mode is off. Start the app with <code className="mono">npm run demo</code> to load sample data and enable this guide.
        </p>
      </>
    );
  }
  if (!demo.seeded) {
    return (
      <>
        <h1>Demo guide</h1>
        <p>
          Demo mode is on but no demo data is loaded. Run <code className="mono">npm run seed:demo -- --reset</code> and reload this page.
        </p>
      </>
    );
  }

  const ev = (key: string) => demo.events.find((e) => e.key === key)!;
  const gate = (key: string) => demo.gates.find((g) => g.key === key)!;
  const venue = (key: string) => demo.venues.find((v) => v.key === key)!;
  const pass = (key: string) => demo.passes.find((p) => p.key === key)!;
  const summit = ev('summit');
  const fair = ev('fair');
  const awards = ev('awards');
  const workshop = ev('workshop');

  /** A button that signs in as `as` and opens `to`. */
  const Go = ({ as, to, children }: { as: string; to: string; children: ReactNode }) => {
    const acct = demo.accounts.find((a) => a.key === as)!;
    const already = user?.email === acct.email;
    return (
      <button className="btn-secondary btn-sm" onClick={() => signInAs(as, to)} title={`Signs in as ${acct.email}`}>
        {children}
        {!already && <span className="muted"> · as {acct.name.split(' ')[0]}</span>}
      </button>
    );
  };
  const CopyPass = ({ k }: { k: string }) => (
    <button className="btn-secondary btn-sm" onClick={() => copy(pass(k).pass_url, k)}>
      {copied === k ? 'Copied ✓' : `Copy ${pass(k).label.split(' —')[0]}’s pass`}
    </button>
  );

  return (
    <div className="demo">
      <p className="small muted">
        <Link to="/demo">Demos</Link> /
      </p>
      <h1>Full demo guide</h1>
      <p className="muted">
        Sample data was loaded {formatDateTime(demo.seeded_at!)}
        {demo.refreshed_at && `, times refreshed ${formatDateTime(demo.refreshed_at)}`}. Everything here is fictional. This page only exists in demo mode.
      </p>
      {notice && <div className="alert alert-ok">{notice}</div>}
      <ErrorMessage error={error} />

      <nav className="toc small">
        <a href="#setup">Before you start</a>
        <a href="#accounts">Accounts</a>
        <a href="#story-a">A · Weekly check-in</a>
        <a href="#story-b">B · Planned visits</a>
        <a href="#story-c">C · Surprise visits</a>
        <a href="#passes">Sample passes</a>
        <a href="#venue-qrs">Venue QR codes</a>
        <a href="#outbox">Email outbox</a>
        <a href="#reset">Reset</a>
      </nav>

      <section id="setup" className="demo-section">
        <h2>Before you start</h2>
        <ul>
          <li>
            The demo covers three workflows: <strong>A</strong> volunteers checking in to sessions with a printed venue QR, <strong>B</strong> an international
            event with imported participants, printed passes and entry/exit gates, and <strong>C</strong> open events with online registration, walk-ins and ID checks.
          </li>
          <li>
            Every <span className="btn-secondary btn-sm demo-inline">button · as Name</span> below signs you in as the right person and opens the right page. You
            are currently signed in as <strong>{user ? `${user.name} (${ROLE_LABEL[user.role]})` : 'nobody'}</strong>.
          </li>
          <li>
            Live sessions were scheduled around the time the demo was loaded. If the demo is later than ~2 hours after loading, press{' '}
            <em>Refresh demo times</em> in <a href="#reset">Reset</a> first.
          </li>
          <li>
            Gate scanning works without hardware: copy a sample pass and paste it into the scanner’s input, then press Enter. A USB/Bluetooth barcode scanner or a
            phone camera (Chrome/Android) also works — scan the QR images in <a href="#passes">Sample passes</a>.
          </li>
          <li>
            To scan venue QR codes with a real phone, set <code className="mono">PUBLIC_BASE_URL=http://&lt;your-laptop-IP&gt;:&lt;port&gt;</code> before{' '}
            <code className="mono">npm run demo</code> so the QR codes point at your laptop, and join the same Wi-Fi (current: <code className="mono">{demo.public_base_url}</code>).
          </li>
          <li>Tip: use a second browser (or a private window) for the volunteer/participant side, so you can keep the admin view open next to it.</li>
        </ul>
      </section>

      <section id="accounts" className="demo-section">
        <h2>Accounts</h2>
        <p className="small muted">
          Password for every account: <code className="mono">{demo.password}</code>
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {demo.accounts.map((a) => (
                <tr key={a.key}>
                  <td>
                    {a.name}
                    <div className="small muted">{a.label}</div>
                  </td>
                  <td className="mono">{a.email}</td>
                  <td>{ROLE_LABEL[a.role as Role]}</td>
                  <td className="right">
                    {user?.email === a.email ? (
                      <span className="small muted">signed in</span>
                    ) : (
                      <button className="btn-secondary btn-sm" onClick={() => signInAs(a.key)}>
                        Sign in
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="story-a" className="demo-section">
        <h2>A · Weekly check-in with a printed venue QR</h2>
        <p className="muted">
          Message: one reusable QR per venue; volunteers choose the activity; the server records the time; duplicates and closed sessions are handled safely.
        </p>
        <ol className="steps">
          <Step title="Show the venue poster">
            <Go as="admin" to={`/admin/qr/${venue('tagore').qr_id}/print`}>
              Open the Tagore QR poster
            </Go>
            <Point>The QR only identifies the venue. It contains no login or session information, so it can stay on the wall all year.</Point>
          </Step>
          <Step title="Scan as a volunteer — choose between overlapping sessions">
            <Go as="priya" to={venue('tagore').path}>
              Scan Tagore as Priya
            </Go>
            <Point>
              Two activities are open at the same venue at the same time, so Priya chooses one. Pick <em>Wednesday Seva</em>, then press <em>Confirm attendance</em>.
              The confirmation shows the server’s tap-in time.
            </Point>
          </Step>
          <Step title="Scan again — no duplicate">
            <Go as="priya" to={venue('tagore').path}>
              Scan Tagore again
            </Go>
            <Point>Confirm Wednesday Seva again: the original tap-in time is returned, not a second record. Network retries behave the same way.</Point>
          </Step>
          <Step title="Same volunteer, another session the same day">
            <Go as="priya" to={venue('amber').path}>
              Scan Amber as Priya
            </Go>
            <Point>Only one session is open here, so it is preselected. Priya now has two separate records today.</Point>
            <Go as="priya" to="/me/attendance">
              Show Priya’s history
            </Go>
          </Step>
          <Step title="Admin: live session dashboard">
            <Go as="admin" to="/admin/sessions">
              Open sessions list
            </Go>
            <Point>
              Filters by date, venue, activity and status; counts per session. Open <em>Wednesday Seva</em>: the list refreshes every 10 s while check-in is open — Priya
              appears there.
            </Point>
          </Step>
          <Step title="Manual add and correction (always with a reason)">
            <Point>
              On <em>Wednesday Seva</em>, press <em>Add manually</em>, search “Jasmine”, give a reason (e.g. “No phone”). Then press <em>Correct</em> on any row to change the
              time or void it — a reason is required and the original value is kept in the history.
            </Point>
            <Go as="admin" to="/admin/audit">
              Show the audit log
            </Go>
          </Step>
          <Step title="Export">
            <Point>
              On a session page, <em>Export CSV</em> downloads activity, date, venue, volunteer, ID, tap-in time and source.
            </Point>
          </Step>
          <Step title="Revoke a compromised QR">
            <Go as="admin" to={`/admin/venues/${venue('amber').id}`}>
              Open the Amber venue
            </Go>
            <Point>
              Press <em>Revoke</em>. Then try{' '}
              <Go as="tom" to={venue('amber').path}>
                scanning Amber as Tom
              </Go>{' '}
              — blocked immediately. Back as admin, press <em>Generate QR code</em> to print a replacement. Existing attendance is untouched.
            </Point>
          </Step>
        </ol>
      </section>

      <section id="story-b" className="demo-section">
        <h2>B · Planned visits — passes, gates, re-entry</h2>
        <p className="muted">
          Message: organisers’ list in, printable passes out, fast unambiguous gates, exact occupancy, and every exception handled at the desk with an audit trail.
        </p>
        <ol className="steps">
          <Step title="Live dashboard">
            <Go as="events" to={`/admin/events/${summit.id}`}>
              Open {summit.name}
            </Go>
            <Point>Inside now, unique check-ins, entries/exits, rejected scans by reason, per-gate totals, and a reconciliation check against the access history.</Point>
          </Step>
          <Step title="Import the participant list (preview first)">
            <a className="btn btn-secondary btn-sm" href="/api/demo/sample-import.csv">
              Download sample CSV
            </a>{' '}
            <Go as="events" to={`/admin/events/${summit.id}/import`}>
              Open Import
            </Go>
            <Point>
              Upload the sample: columns are mapped automatically, Unicode names are kept, and the preview flags an invalid email, a missing country, a duplicate row, a
              person already imported, and a shared email with a different name. Nothing is saved until <em>Import</em>. Upload it again — 0 new rows.
            </Point>
          </Step>
          <Step title="Passes and email delivery">
            <Go as="events" to={`/admin/events/${summit.id}/deliveries`}>
              Open Pass emails
            </Go>
            <Point>
              Every participant got a pass by email. One address bounced — press <em>Retry</em> on the FAILED row. Press <em>Issue & send passes</em> to send passes to the
              newly imported people. The emails appear in the <a href="#outbox">outbox below</a>.
            </Point>
          </Step>
          <Step title="Show a printable pass">
            <a className="btn btn-secondary btn-sm" href={pass('amara').pass_path} target="_blank" rel="noreferrer">
              Open Amara’s pass
            </a>
            <Point>The QR holds only a random code — no name, email or country. Participants print it; no phone or app needed at the gate.</Point>
          </Step>
          <Step title="Gate: entry, duplicate, exit, re-entry">
            <Go as="gate" to={`/staff/gate/${gate('participant-entry').id}`}>
              Open Participant entry scanner
            </Go>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <CopyPass k="amara" />
              <CopyPass k="lucas" />
              <CopyPass k="hiroshi" />
            </div>
            <Point>
              Paste a pass into the scanner and press Enter. Amara → <strong>ENTRY OK</strong>; paste again → <strong>STOP, already inside</strong>. Lucas →{' '}
              <strong>STOP</strong> (already inside). Hiroshi left earlier → re-entry accepted with the same pass. The screen shows gate, mode and operator; never e-mail
              addresses.
            </Point>
            <Go as="desk" to={`/staff/gate/${gate('participant-exit').id}`}>
              Open Participant exit scanner
            </Go>
            <Point>Paste Lucas → EXIT OK. Back at Participant entry he can now enter again.</Point>
          </Step>
          <Step title="Rejected passes never change occupancy">
            <div className="row">
              <CopyPass k="sofia-old" />
              <CopyPass k="fair-peter" />
            </div>
            <Point>
              At Participant entry: Sofia’s old pass (replaced after she lost it) → <strong>revoked</strong>; a Science of the Soul pass → <strong>different event</strong>; any random
              text → <strong>not recognised</strong>. Then show that the dashboard’s rejected-scan counts went up but “Inside now” did not.
            </Point>
          </Step>
          <Step title="Gate operators are limited">
            <Go as="gate" to={`/staff/gate/${gate('fair-lane').id}`}>
              Try the Science of the Soul Fast lane as Gabe
            </Go>
            <Point>Gabe is assigned only to the Planned-visits gates, so this gate is refused. Gate operators also cannot open participant records or change data.</Point>
          </Step>
          <Step title="Exception desk: lost pass">
            <Go as="desk" to={`/staff/desk/${summit.id}`}>
              Open the summit desk
            </Go>
            <Point>
              Search “müller” or “王” (Unicode, partial match). Contact details are masked for desk staff. Open a participant → <em>Replace (lost / damaged)</em>: tick the
              identity-verified box, give a reason, and the new pass prints; the old one stops working at every gate immediately.
            </Point>
          </Step>
          <Step title="Correct a mistaken scan">
            <Point>
              On Amara’s record (after admitting her), press <em>Correct</em> on her entry — e.g. “scanned but turned back”. A correction is appended, the original stays, and
              occupancy goes back down.
            </Point>
            <Go as="events" to={`/admin/events/${summit.id}/participants/${pass('amara').participant_id}`}>
              Open Amara’s record
            </Go>
          </Step>
          <Step title="Access log & exports">
            <Go as="events" to={`/admin/events/${summit.id}/access`}>
              Open access log
            </Go>
            <Point>Filter accepted/rejected, entry/exit, source; export CSV. Participants and attendance export from the Participants tab.</Point>
          </Step>
        </ol>
      </section>

      <section id="story-c" className="demo-section">
        <h2>C · Surprise visits — online registration, walk-ins, identity assurance</h2>
        <p className="muted">
          Message: everyone admitted has a registration and a check-in record; the level of identity checking is chosen per event; nobody needs a smartphone.
        </p>
        <ol className="steps">
          <Step title="Online registration without an account">
            <a className="btn btn-secondary btn-sm" href={`/events/${fair.id}/register`} target="_blank" rel="noreferrer">
              Open the Science of the Soul public form
            </a>
            <Point>Register with a phone number only. A printable pass appears immediately. Submitting the same email/phone again does not create a duplicate.</Point>
          </Step>
          <Step title="Fast check-in — counted once">
            <Go as="desk" to={`/staff/gate/${gate('fair-lane').id}`}>
              Open Science of the Soul Fast lane
            </Go>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <CopyPass k="fair-grace" />
            </div>
            <Point>Grace → CHECKED IN. Scan again → already checked in, with the original time; the count does not increase.</Point>
          </Step>
          <Step title="Walk-in desk with duplicate search">
            <Go as="desk" to={`/staff/desk/${fair.id}`}>
              Open the Science of the Soul desk
            </Go>
            <Point>
              Register a walk-in named “Rachel Goh” → the desk shows a possible existing registration (matched on name) before creating anything. Then register “Mdm
              Wong” with <em>no email or phone</em> ticked → pass prints, <em>Check in now</em>.
            </Point>
          </Step>
          <Step title="Mandatory photo-ID check">
            <Go as="desk" to={`/staff/gate/${gate('awards-door').id}`}>
              Open Awards Night door
            </Go>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <CopyPass k="awards-grace" />
            </div>
            <Point>
              Grace Lim → <strong>STOP: photo ID required</strong>. Press <em>ID matches — admit</em> → checked in. Only the result, staff member and time are stored —
              never document numbers or images. Overrides need desk authority and a reason.
            </Point>
          </Step>
          <Step title="Email verification (contact, not identity)">
            <a className="btn btn-secondary btn-sm" href={`/events/${workshop.id}/register`} target="_blank" rel="noreferrer">
              Open the Workshop form
            </a>
            <Point>
              Register with any email. Take the 6-digit code from the <a href="#outbox">outbox below</a> and enter it; only then is the pass emailed. The wording is clear
              that this proves access to an email address, not who someone is.
            </Point>
          </Step>
          <Step title="Event settings & reports">
            <Go as="events" to={`/admin/events/${awards.id}/settings`}>
              Open Awards Night settings
            </Go>
            <Point>
              Re-entry, online registration, walk-ins, capacity and verification policy are per event. The overview distinguishes online vs walk-in, contact-verified,
              ID-checked, checked-in and inside.
            </Point>
            <Go as="events" to={`/admin/events/${fair.id}`}>
              Science of the Soul overview
            </Go>
          </Step>
        </ol>
      </section>

      <section id="passes" className="demo-section">
        <h2>Sample passes</h2>
        <p className="small muted">Scan these from the screen with a camera or scanner, or use “Copy” and paste into a gate scanner.</p>
        <div className="grid">
          {demo.passes.map((p) => (
            <div key={p.key} className="card">
              <img src={p.qr_data_url} alt={`Pass QR for ${p.label}`} style={{ width: 140, height: 140, imageRendering: 'pixelated' }} />
              <div>
                <strong>{p.label}</strong>
              </div>
              <div className="small">{demo.events.find((e) => e.key === p.event_key)?.name}</div>
              <div className="small muted">{p.note}</div>
              <div className="small" style={{ margin: '0.4rem 0' }}>
                Expected: <strong>{p.expect}</strong>
              </div>
              <div className="row">
                <button className="btn-secondary btn-sm" onClick={() => copy(p.pass_url, p.key)}>
                  {copied === p.key ? 'Copied ✓' : 'Copy'}
                </button>
                <a className="btn btn-secondary btn-sm" href={p.pass_path} target="_blank" rel="noreferrer">
                  Printable
                </a>
              </div>
            </div>
          ))}
        </div>
        <h3>Gates</h3>
        <ul className="small">
          {demo.gates.map((g) => (
            <li key={g.id}>
              <Link to={`/staff/gate/${g.id}`}>{g.name}</Link> — {g.mode} · {demo.events.find((e) => e.key === g.event_key)?.name}
            </li>
          ))}
        </ul>
      </section>

      <section id="venue-qrs" className="demo-section">
        <h2>Venue QR codes</h2>
        <div className="grid">
          {demo.venues.map((v) => (
            <div key={v.key} className="card">
              <img src={v.qr_data_url} alt={`Venue QR for ${v.name}`} style={{ width: 140, height: 140, imageRendering: 'pixelated' }} />
              <div>
                <strong>{v.name}</strong>
              </div>
              <div className="small muted">{v.note}</div>
              <Link className="small" to={v.path}>
                Open check-in page
              </Link>
            </div>
          ))}
        </div>
      </section>

      <Outbox />

      <section id="reset" className="demo-section">
        <h2>Reset</h2>
        <ul>
          <li>
            <strong>Refresh demo times</strong> moves today’s sessions and the events back around the current time (keeps everything you did).{' '}
            <button
              className="btn-secondary btn-sm"
              onClick={async () => {
                setError(null);
                try {
                  await signInAs('admin');
                  const r = await api.post<{ sessions: number; events: number }>('/demo/refresh');
                  setNotice(`Refreshed ${r.sessions} sessions and ${r.events} events.`);
                  setDemo(await loadDemo(true));
                } catch (err) {
                  setError(err);
                }
              }}
            >
              Refresh demo times
            </button>
          </li>
          <li>
            <strong>Start completely fresh:</strong> stop the app and run <code className="mono">npm run demo</code> again (it wipes and reloads the demo database only).
          </li>
        </ul>
      </section>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="step">
      <div className="step-title">{title}</div>
      <div className="step-body">{children}</div>
    </li>
  );
}

function Point({ children }: { children: ReactNode }) {
  return <p className="step-point">{children}</p>;
}

function Outbox() {
  const [messages, setMessages] = useState<OutboxMessage[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setMessages((await api.get<{ messages: OutboxMessage[] }>('/demo/outbox')).messages);
    } catch {
      setMessages([]);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <section id="outbox" className="demo-section">
      <div className="spread">
        <h2>Email outbox</h2>
        <button className="btn-secondary btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="small muted">In demo mode emails are not sent — the latest 50 appear here (verification codes, passes). Updates every 5 seconds.</p>
      {messages && messages.length === 0 && <p className="muted">No emails yet in this session.</p>}
      {messages && messages.length > 0 && (
        <table>
          <tbody>
            {messages.map((m, i) => {
              const code = /code is (\d{6})/.exec(m.text)?.[1];
              return (
                <tr key={`${m.sent_at}-${i}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(m.sent_at)}</td>
                  <td>{m.to}</td>
                  <td>
                    {m.subject}
                    {code && (
                      <>
                        {' '}
                        — code <strong className="mono">{code}</strong>
                      </>
                    )}
                    {open === i && <pre className="small mono" style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0 0' }}>{m.text}</pre>}
                  </td>
                  <td className="right">
                    <button className="btn-link small" onClick={() => setOpen(open === i ? null : i)}>
                      {open === i ? 'hide' : 'view'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

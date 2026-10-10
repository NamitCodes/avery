import { useEffect, useState } from 'react';
import { api } from './api';

export interface DemoInfo {
  enabled: boolean;
  seeded: boolean;
  seeded_at?: string;
  refreshed_at?: string | null;
  password: string;
  accounts: { key: string; email: string; name: string; role: string; label: string; id: string }[];
  venues: { key: string; id: string; name: string; note: string; qr_id: string; checkin_url: string; path: string; qr_data_url: string }[];
  events: { key: string; id: string; name: string }[];
  gates: { key: string; id: string; name: string; mode: string; event_key: string }[];
  passes: {
    key: string;
    label: string;
    note: string;
    expect: string;
    event_key: string;
    participant_id: string;
    credential_id: string;
    status?: string;
    pass_url: string;
    pass_path: string;
    qr_data_url: string;
  }[];
  public_base_url: string;
}

let cached: Promise<DemoInfo | null> | null = null;

/** Demo-guide data, or null when the server is not in demo mode. */
export function loadDemo(force = false): Promise<DemoInfo | null> {
  if (!cached || force) cached = api.get<DemoInfo>('/demo').catch(() => null);
  return cached;
}

export function useDemo() {
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadDemo().then((d) => alive && setDemo(d));
    return () => {
      alive = false;
    };
  }, []);
  return demo;
}

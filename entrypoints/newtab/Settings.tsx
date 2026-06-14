import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createFeedClient,
  loadConfig,
  originPattern,
  requestHostAccess,
  saveConfig,
  safeHttpUrl,
} from './feed';

interface SettingsProps {
  onSaved: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; count: number }
  | { kind: 'error'; message: string };

/** Exhaustive over Status — a new variant without a case fails the build. */
function statusText(status: Status): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'testing':
      return 'Testing…';
    case 'ok':
      return `Connected — ${status.count} ${status.count === 1 ? 'item' : 'items'} queued.`;
    case 'error':
      return status.message;
  }
}

export default function Settings({ onSaved }: SettingsProps) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false); // re-entrancy lock (disabled prop is render-timing, not a lock)
  const genRef = useRef(0); // bumped on close so an in-flight save can't write after close
  const prefilled = useRef<{ baseUrl: string; token: string } | null>(null); // last loaded values

  // Prefill from storage each time the modal opens, then focus the first field.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadConfig()
      .then((cfg) => {
        if (cancelled) return;
        prefilled.current = cfg;
        setBaseUrl(cfg.baseUrl);
        setToken(cfg.token);
        setStatus({ kind: 'idle' });
        firstFieldRef.current?.focus();
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'error', message: 'Couldn’t load saved settings.' });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  };

  // Don't carry a token to a different host: if the URL's host changes away from
  // what was loaded and the token is still the prefilled one, clear it.
  const onBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    const pf = prefilled.current;
    if (pf && token && token === pf.token && hostOf(value) && hostOf(value) !== hostOf(pf.baseUrl)) {
      setToken('');
    }
  };

  const close = useCallback(() => {
    genRef.current += 1; // invalidate any in-flight save
    setOpen(false);
    buttonRef.current?.focus(); // return focus to the trigger
  }, []);

  // While open, own Escape + Tab globally in the capture phase: Escape closes
  // (stopPropagation keeps App's Escape-clears-search from also firing), Tab
  // wraps focus inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // Save then verify: request host access, persist, then fetch with the values.
  const save = async () => {
    if (savingRef.current) return; // ignore double-submit
    const url = baseUrl.trim();
    if (!safeHttpUrl(url)) {
      setStatus({ kind: 'error', message: 'Enter a valid http(s) URL.' });
      return;
    }
    const parsed = new URL(url);
    if (!originPattern(url)) {
      setStatus({ kind: 'error', message: 'Enter a specific host (no wildcards).' });
      return;
    }
    const config = { baseUrl: url, token: token.trim() };
    if (config.token && parsed.protocol !== 'https:') {
      setStatus({ kind: 'error', message: 'Use an https URL when sending a token.' });
      return;
    }

    const gen = genRef.current;
    savingRef.current = true;
    setStatus({ kind: 'testing' });
    let next: Status;
    let saved = false;
    try {
      // Ask for access to this host first, while the click gesture is still live.
      const granted = await requestHostAccess(url);
      if (!granted) {
        next = { kind: 'error', message: `Allow access to ${parsed.hostname} to connect.` };
      } else {
        await saveConfig(config);
        saved = true;
        const items = await createFeedClient(config).fetchQueue();
        next = { kind: 'ok', count: items.length };
      }
    } catch (e) {
      // Show our own status messages, never arbitrary thrown text.
      const message =
        e instanceof Error && e.message.startsWith('Feed ')
          ? e.message
          : 'Couldn’t reach the server — check the URL and token.';
      next = { kind: 'error', message };
    } finally {
      savingRef.current = false;
    }
    // The config (and host grant) are persisted regardless of modal state, so
    // refresh the row even if the modal was closed mid-request.
    if (saved) onSaved();
    if (gen !== genRef.current) return; // only the visible status is gated by close
    setStatus(next);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="settings-btn"
        aria-label="Settings"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="settings-overlay" onClick={close}>
          <div
            ref={dialogRef}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="settings-title" className="settings-title">Pins source</h2>
            <p className="settings-help">
              Point this at a server that implements the marktab queue API (see the README). Leave it
              blank to hide the Pins row.
            </p>

            <label className="settings-field">
              <span>Base URL</span>
              <input
                ref={firstFieldRef}
                type="url"
                inputMode="url"
                placeholder="https://host:3335"
                value={baseUrl}
                onChange={(e) => onBaseUrlChange(e.target.value)}
              />
            </label>

            <label className="settings-field">
              <span>API token</span>
              <div className="settings-token">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder="optional"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button
                  type="button"
                  className="settings-reveal"
                  aria-pressed={showToken}
                  onClick={() => setShowToken((s) => !s)}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>

            <p className={`settings-status settings-status--${status.kind}`} aria-live="polite">
              {statusText(status)}
            </p>

            <div className="settings-actions">
              <button type="button" className="settings-cancel" onClick={close}>
                Close
              </button>
              <button
                type="button"
                className="settings-save"
                onClick={save}
                disabled={status.kind === 'testing'}
              >
                Save &amp; test
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

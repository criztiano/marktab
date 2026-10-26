import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Thumb from './Thumb';
import {
  createFeedClient,
  createLatestCacheWriter,
  feedErrorKind,
  hasHostAccess,
  loadCachedItems,
  loadConfig,
  requestHostAccess,
  safeDestinationUrl,
  safeMediaUrl,
  type FeedClient,
  type FeedConfig,
  type FeedErrorKind,
  type LatestCacheWriter,
  type PinItem,
} from './feed';
import {
  createNote,
  loadNotes,
  noteSize,
  NOTE_COLORS,
  saveNotes,
  watchNotes,
  type NoteColor,
  type PinNote,
} from './notes';
import { displayHost, faviconUrl, useDelayedFlag } from './view-helpers';

export type PinsAvailability = 'unconfigured' | 'needs-access' | 'enabling' | 'ready';

interface FeedQueueState {
  items: PinItem[];
  failed: boolean;
  errorKind: FeedErrorKind | null;
  /** The first live answer (or a cached list) has arrived. */
  settled: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  unpin: (id: string) => void;
  enable: () => void;
  retry: () => void;
}

interface RefreshTicket {
  requestId: number;
  mutationEpoch: number;
}

interface UnpinTicket {
  item: PinItem;
  index: number;
  epoch: number;
}

interface Suppression {
  epoch: number;
  confirmed: boolean;
}

/** Own optimistic-removal suppression and refresh ordering independently from
 * React render timing so stale requests cannot resurrect a confirmed unpin and
 * failed mutations can invalidate in-flight projections before rollback. */
export class PinProjection {
  private mutationEpoch = 0;
  private latestRefresh = 0;
  private readonly suppressions = new Map<string, Suppression>();

  beginRefresh(): RefreshTicket {
    return { requestId: ++this.latestRefresh, mutationEpoch: this.mutationEpoch };
  }

  beginUnpin(item: PinItem, index: number): UnpinTicket {
    const epoch = ++this.mutationEpoch;
    this.suppressions.set(item.id, { epoch, confirmed: false });
    return { item, index, epoch };
  }

  confirmUnpin(ticket: UnpinTicket): boolean {
    const marker = this.suppressions.get(ticket.item.id);
    if (!marker || marker.epoch !== ticket.epoch) return false;
    marker.confirmed = true;
    return true;
  }

  rollbackUnpin(ticket: UnpinTicket, current: PinItem[]): PinItem[] {
    const marker = this.suppressions.get(ticket.item.id);
    if (!marker || marker.epoch !== ticket.epoch) return current;
    this.suppressions.delete(ticket.item.id);
    // No request which observed the temporary suppression may overwrite the rollback.
    this.latestRefresh += 1;
    if (current.some((item) => item.id === ticket.item.id)) return current;
    const restored = [...current];
    restored.splice(Math.min(ticket.index, restored.length), 0, ticket.item);
    return restored;
  }

  project(ticket: RefreshTicket, incoming: PinItem[]): PinItem[] | null {
    if (ticket.requestId !== this.latestRefresh) return null;
    const incomingIds = new Set(incoming.map((item) => item.id));
    for (const [id, marker] of this.suppressions) {
      if (marker.confirmed && ticket.mutationEpoch >= marker.epoch && !incomingIds.has(id)) {
        this.suppressions.delete(id);
      }
    }
    return incoming.filter((item) => !this.suppressions.has(item.id));
  }

  isAuthoritative(): boolean {
    return this.suppressions.size === 0;
  }
}

/** Persist server-confirmed projections only. Optimistic removals stay visual;
 * the last authoritative cache survives a rejected POST or page close. */
export function persistAuthoritativeProjection(
  projection: PinProjection,
  writer: LatestCacheWriter,
  items: PinItem[],
): Promise<void> | null {
  return projection.isAuthoritative() ? writer.enqueue(items) : null;
}

// One owner per extension page module, rather than one per React mount.
const sharedPinsCacheWriter = createLatestCacheWriter();

/** Keep permissions.request as the first async operation reached by the button
 * so Chrome can associate it with the user's click gesture. */
export function requestPinsAccess(
  baseUrl: string,
  request: (url: string) => Promise<boolean> = requestHostAccess,
): Promise<boolean> {
  return request(baseUrl);
}

/** The one still image a row shows: a direct public image, else a video's
 * poster. Video itself never plays in the list. */
export function pinImage(item: PinItem): string | null {
  if (item.media?.kind === 'image') {
    const image = safeMediaUrl(item.media.url);
    if (image) return image;
  }
  if (item.media?.kind === 'video') {
    const poster = safeMediaUrl(item.media.poster_url);
    if (poster) return poster;
  }
  return safeMediaUrl(item.image_url);
}

/** Stale-while-revalidate with explicit host-access onboarding. */
function useFeedQueue(): FeedQueueState {
  const [items, setItems] = useState<PinItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [errorKind, setErrorKind] = useState<FeedErrorKind | null>(null);
  const [settled, setSettled] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [availability, setAvailability] = useState<PinsAvailability>('unconfigured');
  const clientRef = useRef<FeedClient | null>(null);
  const configRef = useRef<FeedConfig | null>(null);
  const projectionRef = useRef(new PinProjection());
  const mountedRef = useRef(false);
  const retryingRef = useRef(false);
  const enablingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (isRetry: boolean) => {
      const client = clientRef.current;
      if (!client || retryingRef.current) return;
      const ticket = projectionRef.current.beginRefresh();
      if (isRetry) {
        retryingRef.current = true;
        if (mountedRef.current) setRetrying(true);
      }
      try {
        const fresh = await client.fetchQueue();
        if (!mountedRef.current) return;
        const projected = projectionRef.current.project(ticket, fresh);
        if (projected === null) return;
        setItems(projected);
        const cacheWrite = persistAuthoritativeProjection(
          projectionRef.current,
          sharedPinsCacheWriter,
          projected,
        );
        if (cacheWrite) void cacheWrite.catch(() => {});
        setFailed(false);
        setErrorKind(null);
      } catch (error) {
        if (!mountedRef.current) return;
        setFailed(true);
        setErrorKind(feedErrorKind(error));
      } finally {
        if (mountedRef.current) setSettled(true);
        if (isRetry) {
          retryingRef.current = false;
          if (mountedRef.current) setRetrying(false);
        }
      }
    },
    [],
  );

  const activate = useCallback(
    async (config: FeedConfig, showProgress: boolean) => {
      setFailed(false);
      let cached: PinItem[] = [];
      try {
        cached = await loadCachedItems();
      } catch {
        // A damaged/missing cache must not block a live fetch after access is granted.
      }
      if (!mountedRef.current) return;
      if (cached.length) {
        const projected = projectionRef.current.project(
          projectionRef.current.beginRefresh(),
          cached,
        );
        if (projected) setItems(projected);
        setSettled(true);
      }
      clientRef.current = createFeedClient(config);
      if (!showProgress) setAvailability('ready');
      await refresh(false);
      if (showProgress && mountedRef.current) setAvailability('ready');
      enablingRef.current = false;
    },
    [refresh],
  );

  useEffect(() => {
    void (async () => {
      let config: FeedConfig;
      try {
        config = await loadConfig();
      } catch {
        return;
      }
      if (!mountedRef.current || !config.baseUrl) return;
      configRef.current = config;
      let permitted = false;
      try {
        permitted = await hasHostAccess(config.baseUrl);
      } catch {
        // Keep onboarding visible and let the explicit click try again.
      }
      if (!permitted) {
        if (mountedRef.current) setAvailability('needs-access');
        return;
      }
      if (mountedRef.current) await activate(config, false);
    })();
  }, [activate]);

  const enable = () => {
    const config = configRef.current;
    if (!config || enablingRef.current) return;
    enablingRef.current = true;
    const permission = requestPinsAccess(config.baseUrl);
    setAvailability('enabling');
    void permission
      .then((granted) => {
        if (!mountedRef.current) return;
        if (!granted) {
          enablingRef.current = false;
          setAvailability('needs-access');
          return;
        }
        void activate(config, true);
      })
      .catch(() => {
        enablingRef.current = false;
        if (mountedRef.current) setAvailability('needs-access');
      });
  };

  const unpin = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    const client = clientRef.current;
    if (!item || !client) return;
    const ticket = projectionRef.current.beginUnpin(item, index);
    setItems((previous) => previous.filter((candidate) => candidate.id !== id));
    void client
      .unpin(id)
      .then(() => {
        if (projectionRef.current.confirmUnpin(ticket)) void refresh(false);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setItems((previous) => projectionRef.current.rollbackUnpin(ticket, previous));
        setFailed(true);
        setErrorKind(feedErrorKind(error));
      });
  };

  return {
    items,
    failed,
    errorKind,
    settled,
    retrying,
    availability,
    unpin,
    enable,
    retry: () => void refresh(true),
  };
}

/** Local notes: optimistic in memory, persisted to storage, synced across tabs. */
function useNotes() {
  const [notes, setNotes] = useState<PinNote[]>([]);
  const notesRef = useRef<PinNote[]>([]);

  useEffect(() => {
    let alive = true;
    const apply = (next: PinNote[]) => {
      notesRef.current = next;
      if (alive) setNotes(next);
    };
    void loadNotes().then(apply, () => {});
    const stop = watchNotes(apply);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const commit = (next: PinNote[]) => {
    notesRef.current = next;
    setNotes(next);
    void saveNotes(next).catch(() => {});
  };

  return {
    notes,
    addNote: (text: string, by: string) => {
      const note = createNote(text, by);
      if (note) commit([note, ...notesRef.current]);
    },
    removeNote: (id: string) => commit(notesRef.current.filter((note) => note.id !== id)),
    recolorNote: (id: string, color: NoteColor) =>
      commit(notesRef.current.map((note) => (note.id === id ? { ...note, color } : note))),
  };
}

const NOTE_COLOR_NAMES = Object.keys(NOTE_COLORS) as NoteColor[];

function NoteCard({
  note,
  onRemove,
  onRecolor,
}: {
  note: PinNote;
  onRemove: () => void;
  onRecolor: (color: NoteColor) => void;
}) {
  const color = note.color ?? 'lime';
  const style = { '--note-mark': NOTE_COLORS[color] } as CSSProperties;
  const label = note.by ? `quote by ${note.by}` : 'note';
  return (
    <li className="row note" data-size={noteSize(note.text)} style={style}>
      <figure className="note-body">
        {note.by ? (
          <>
            <blockquote className="note-text">
              <mark>“{note.text}”</mark>
            </blockquote>
            <figcaption className="note-by">— {note.by}</figcaption>
          </>
        ) : (
          <p className="note-text">
            <mark>{note.text}</mark>
          </p>
        )}
      </figure>
      <span className="note-tools">
        <span className="note-colors" role="group" aria-label="Highlighter colour">
          {NOTE_COLOR_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className="note-dot"
              style={{ '--dot': NOTE_COLORS[name] } as CSSProperties}
              aria-label={name}
              aria-pressed={name === color}
              onClick={() => onRecolor(name)}
            />
          ))}
        </span>
        <button
          type="button"
          className="row-action pressable"
          aria-label={`Remove ${label}: ${note.text}`}
          onClick={onRemove}
        >
          ×
        </button>
      </span>
    </li>
  );
}

function NoteComposer({ onSave, onClose }: { onSave: (text: string, by: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [by, setBy] = useState('');

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim()) return;
    onSave(text, by);
    onClose();
  };

  // Keep Escape and typing inside the composer instead of the page search.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') onClose();
    if (event.key === 'Enter' && !event.shiftKey && event.target instanceof HTMLTextAreaElement) submit(event);
  };

  return (
    <li className="row note note--draft">
      <form className="note-body note-form" onSubmit={submit} onKeyDown={onKeyDown}>
        <textarea
          className="note-input note-input--text"
          aria-label="Note or quote"
          placeholder="A note or quote…"
          maxLength={280}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <input
          className="note-input"
          aria-label="Who said it (optional)"
          placeholder="— who said it (optional)"
          maxLength={80}
          autoComplete="off"
          value={by}
          onChange={(event) => setBy(event.target.value)}
        />
        <span className="note-actions button-group">
          <button type="button" className="text-button pressable" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="text-button text-button--primary pressable" disabled={!text.trim()}>
            Add note
          </button>
        </span>
      </form>
    </li>
  );
}

const ERROR_COPY: Record<FeedErrorKind, string> = {
  offline: 'Couldn’t reach the server. Check your connection.',
  auth: 'The server didn’t accept the key. Check Settings.',
  missing: 'This server doesn’t offer Pins.',
  server: 'The server had a problem.',
};

interface PinsViewProps {
  items: PinItem[];
  failed: boolean;
  errorKind?: FeedErrorKind | null;
  settled?: boolean;
  showSkeleton?: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  unpin: (id: string) => void;
  enable: () => void;
  retry: () => void;
  notes?: PinNote[];
  addNote?: (text: string, by: string) => void;
  removeNote?: (id: string) => void;
  recolorNote?: (id: string, color: NoteColor) => void;
}

const noop = () => {};

export function PinsView({
  items,
  failed,
  errorKind = null,
  settled = true,
  showSkeleton = false,
  retrying,
  availability,
  unpin,
  enable,
  retry,
  notes = [],
  addNote = noop,
  removeNote = noop,
  recolorNote = noop,
}: PinsViewProps) {
  const [composing, setComposing] = useState(false);
  const safe = items.filter((item) => safeDestinationUrl(item.url));
  const hasCards = safe.length > 0;
  const hasNotes = notes.length > 0 || composing;
  const needsOnboarding = availability === 'needs-access' || availability === 'enabling';
  const isEmpty = !hasCards && !hasNotes && !failed;

  return (
    <section className="block pins" aria-labelledby="pins-title">
      <div className="block-head">
        <h2 className="block-title" id="pins-title">
          Pins
        </h2>
        <button
          type="button"
          className="text-button pressable"
          onClick={() => setComposing(true)}
          disabled={composing}
        >
          + Note
        </button>
      </div>
      {hasNotes && (
        <ul className="rows notes" aria-label="Notes">
          {composing && <NoteComposer onSave={addNote} onClose={() => setComposing(false)} />}
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onRemove={() => removeNote(note.id)}
              onRecolor={(color) => recolorNote(note.id, color)}
            />
          ))}
        </ul>
      )}
      {hasCards && (
        <ul className="rows">
          {safe.map((item) => {
            const host = displayHost(item.url);
            return (
              <li key={item.id} className="row">
                <a className="row-link pressable" href={item.url} title={`${item.title}\n${host}`}>
                  <Thumb favicon={faviconUrl(item.url)} image={pinImage(item)} shape="wide" lazy />
                  <span className="row-text">
                    <span className="row-title row-title--clamp">{item.title}</span>
                    <span className="row-meta">{host}</span>
                  </span>
                </a>
                <button
                  type="button"
                  className="row-action pressable"
                  aria-label={`Unpin ${item.title}`}
                  onClick={() => unpin(item.id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {availability === 'ready' && !hasCards && !settled && showSkeleton && (
        <ul className="rows" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="row row--skeleton">
              <span className="thumb thumb--wide" />
              <span className="skeleton-line" />
            </li>
          ))}
        </ul>
      )}
      {!hasCards && needsOnboarding && (
        <p className="block-note" role="status">
          <span>Pins is configured. Chrome needs access to that host.</span>
          <button
            type="button"
            className="text-button text-button--primary pressable"
            onClick={enable}
            disabled={availability === 'enabling'}
          >
            {availability === 'enabling' ? 'Enabling…' : 'Enable Pins'}
          </button>
        </p>
      )}
      {isEmpty && availability === 'ready' && settled && (
        <p className="block-note">
          Nothing pinned yet. Pin a page in <span translate="no">Garden</span>, or add a note.
        </p>
      )}
      {isEmpty && availability === 'unconfigured' && (
        <p className="block-note">Add a note or quote to keep it in view.</p>
      )}
      {failed && (
        <p className="block-note block-note--error" role="status">
          <span>
            {hasCards ? 'Couldn’t refresh Pins.' : 'Pins couldn’t load.'}
            {errorKind && ` ${ERROR_COPY[errorKind]}`}
          </span>
          <button type="button" className="text-button pressable" onClick={retry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}
    </section>
  );
}

export default function Pins() {
  const queue = useFeedQueue();
  const notes = useNotes();
  const showSkeleton = useDelayedFlag(queue.availability === 'ready' && !queue.settled);
  return <PinsView {...queue} {...notes} showSkeleton={showSkeleton} />;
}

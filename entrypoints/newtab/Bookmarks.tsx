import { useEffect, useRef, useState } from 'react';
import type { Bookmark } from './Search';
import { faviconUrl } from './view-helpers';

type Edges = { start: boolean; end: boolean };

/** Which ends of the strip have more bookmarks past them, so only those fade. */
function useOverflowEdges(content: unknown) {
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const start = strip.scrollLeft > 1;
      const end = strip.scrollLeft < max - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    strip.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [content]);
  return { ref, edges };
}

/** Every shown bookmark as one horizontally scrolling row of mini cards. */
export function BookmarksView({ bookmarks, loaded }: { bookmarks: Bookmark[]; loaded: boolean }) {
  const { ref, edges } = useOverflowEdges(bookmarks);
  return (
    <section className="bookmarks" aria-labelledby="bookmarks-title">
      <h2 className="sr-only" id="bookmarks-title">
        Bookmarks
      </h2>
      {loaded && bookmarks.length === 0 ? (
        <p className="block-note">Bookmarks you save in Chrome show up here.</p>
      ) : (
        <ul
          ref={ref}
          className="strip"
          data-fade-start={edges.start || undefined}
          data-fade-end={edges.end || undefined}
        >
          {bookmarks.map((b) => (
            <li key={b.id}>
              <a className="chip pressable" href={b.url} title={`${b.title}\n${b.url}`}>
                <img src={faviconUrl(b.url)} alt="" width={24} height={24} decoding="async" />
                <span className="chip-title">{b.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

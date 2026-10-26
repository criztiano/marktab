import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PinMedia } from './feed';

interface PlaybackPolicy {
  inView: boolean;
  reducedMotion: boolean;
  failed: boolean;
}

export function shouldPlayVideo({ inView, reducedMotion, failed }: PlaybackPolicy): boolean {
  return inView && !reducedMotion && !failed;
}

/** Omitting src (rather than relying on preload="none") is the network gate.
 * With reduced motion the video never loads: the poster is all that shows. */
export function videoSource(url: string, nearViewport: boolean, reducedMotion: boolean): string | undefined {
  return nearViewport && !reducedMotion ? url : undefined;
}

function useIntersecting(target: RefObject<HTMLElement>, enabled: boolean, options: IntersectionObserverInit) {
  const [hit, setHit] = useState(false);
  const { rootMargin, threshold } = options;
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setHit(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setHit(entry.isIntersecting), { rootMargin, threshold });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, target, rootMargin, threshold]);
  return hit;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

const NEAR = { rootMargin: '240px 0px' };
const VISIBLE = { threshold: 0.5 };

/** 16:9 leading media for a Review row. An image shows as a still; a video is
 * muted and looping, attaches its source only near the viewport, plays only
 * while at least half visible, and never moves under reduced motion. Any load
 * error removes the media, leaving a text-only row. */
export default function ReviewMedia({ media }: { media: PinMedia }) {
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = media.kind === 'video';
  const reducedMotion = useReducedMotion();
  const near = useIntersecting(boxRef, isVideo && !failed, NEAR);
  const inView = useIntersecting(boxRef, isVideo && !failed, VISIBLE);
  const [attached, setAttached] = useState(false);

  useEffect(() => setFailed(false), [media.url]);
  useEffect(() => {
    if (near) setAttached(true); // once loaded, keep the source; only playback follows the viewport
  }, [near]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlayVideo({ inView, reducedMotion, failed })) void video.play().catch(() => {});
    else video.pause();
  }, [inView, reducedMotion, failed, attached]);

  if (failed || (isVideo && reducedMotion && !media.poster_url)) return null;

  return (
    <span ref={boxRef} className="thumb thumb--wide" aria-hidden="true">
      {media.kind === 'image' || reducedMotion ? (
        <img
          className="thumb-image"
          src={media.kind === 'image' ? media.url : media.poster_url}
          alt=""
          width={96}
          height={54}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          ref={videoRef}
          className="thumb-image"
          src={videoSource(media.url, attached, reducedMotion)}
          poster={media.poster_url}
          width={96}
          height={54}
          crossOrigin="anonymous"
          muted
          loop
          playsInline
          preload={attached ? 'metadata' : 'none'}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

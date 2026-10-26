import { useEffect, useState } from 'react';

interface ThumbProps {
  /** Page whose Chrome-cached favicon shows on the placeholder block. */
  favicon: string;
  /** Direct public image, already checked with safeMediaUrl. */
  image?: string | null;
  shape: 'square' | 'wide';
  /** Below-the-fold images wait until they are near the viewport. */
  lazy?: boolean;
}

const SIZE = { square: [32, 32], wide: [96, 54] } as const;

/** Leading media for a row: a neutral block with the local favicon, covered by
 * the image once it loads. A failed image simply leaves the favicon showing. */
export default function Thumb({ favicon, image, shape, lazy = false }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image]);
  const [width, height] = SIZE[shape];
  const loading = lazy ? 'lazy' : undefined;
  return (
    <span className={`thumb thumb--${shape}`} aria-hidden="true">
      <img className="thumb-icon" src={favicon} alt="" width={16} height={16} loading={loading} decoding="async" />
      {image && !failed && (
        <img
          className="thumb-image"
          src={image}
          alt=""
          width={width}
          height={height}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          loading={loading}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

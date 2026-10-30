import React, { useCallback, useEffect, useRef, useState } from 'react';
import MedicineThumbnail from '../common/MedicineThumbnail';

/** Swipeable photo gallery: native scroll-snap, pagination dots, and an illustrated fallback when there are no (working) photos. */
export default function ImageCarousel({ images, medicine }) {
  const trackRef = useRef(null);
  const frame = useRef(0);
  const [active, setActive] = useState(0);
  const [broken, setBroken] = useState(() => new Set());
  const slides = images.length > 0 ? images : [null];

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const track = trackRef.current;
      if (track && track.clientWidth) setActive(Math.round(track.scrollLeft / track.clientWidth));
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const goTo = (index) => {
    const track = trackRef.current;
    if (track && track.scrollTo) track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    setActive(index);
  };
  const markBroken = (url) => setBroken((prev) => new Set(prev).add(url));

  return (
    <div className="pd-carousel">
      <div className="pd-track" ref={trackRef} onScroll={onScroll} role="group" aria-roledescription="carousel" aria-label={`${medicine.name} photos`}>
        {slides.map((image, index) => (
          <div className="pd-slide" key={image ? image.url : 'art'} aria-label={`Photo ${index + 1} of ${slides.length}`}>
            {image && !broken.has(image.url)
              ? <img src={image.url} alt={image.caption ? `${medicine.name}: ${image.caption}` : medicine.name} loading={index === 0 ? 'eager' : 'lazy'} decoding="async" onError={() => markBroken(image.url)} />
              : <div className="pd-art"><MedicineThumbnail medicine={medicine} size={240} /></div>}
          </div>
        ))}
      </div>
      {slides.length > 1 && (
        <div className="pd-dots" role="tablist" aria-label="Photo pagination">
          {slides.map((image, index) => (
            <button key={image ? image.url : index} type="button" role="tab" className={`pd-dot ${index === active ? 'on' : ''}`}
              aria-selected={index === active} aria-label={`Photo ${index + 1}`} onClick={() => goTo(index)} />
          ))}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLocation } from '../../context/LocationContext';
import { useBackHandler } from '../../hooks/useBackHandler';
import { DEFAULT_MAP_CENTER, MAP_ATTRIBUTION, mapTileUrl } from '../../config/app';
import '../../assets/product-detail.css';

const round6 = (n) => Math.round(n * 1e6) / 1e6;   // ~10 cm: more than a doorstep needs

/**
 * Full-screen "place the pin on your doorstep" step. The pin stays in the centre and the map moves under it (Blinkit / Zomato style),
 * which is easier to do accurately with a thumb than dragging a tiny marker. Confirming returns the exact coordinates for the order.
 */
export default function PinpointSheet({ initial, onConfirm, onClose }) {
  const start = initial && Number.isFinite(initial.lat) && Number.isFinite(initial.lng) ? initial : DEFAULT_MAP_CENTER;
  const holderRef = useRef(null);
  const mapRef = useRef(null);
  const { location, detectLocation, detecting, error } = useLocation();
  const [center, setCenter] = useState({ lat: start.lat, lng: start.lng });
  const [moving, setMoving] = useState(false);
  const [wantGps, setWantGps] = useState(false);

  useBackHandler(true, onClose);

  useEffect(() => {
    const map = L.map(holderRef.current, { zoomControl: false, attributionControl: true }).setView([start.lat, start.lng], 17);
    L.tileLayer(mapTileUrl(), { maxZoom: 19, attribution: MAP_ATTRIBUTION }).addTo(map);
    map.on('movestart', () => setMoving(true));
    map.on('moveend', () => { const c = map.getCenter(); setCenter({ lat: c.lat, lng: c.lng }); setMoving(false); });
    mapRef.current = map;
    const timer = setTimeout(() => map.invalidateSize(), 250);
    return () => { clearTimeout(timer); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Use my location": run the GPS read, then centre the map on the result.
  useEffect(() => {
    if (!wantGps || detecting || !location || !mapRef.current) return;
    mapRef.current.setView([location.lat, location.lng], 18);
    setWantGps(false);
  }, [wantGps, detecting, location]);

  return (
    <div className="swm-back" role="dialog" aria-modal="true" aria-label="Confirm delivery location">
      <div className="swm-head">
        <button type="button" className="pd-icon-btn" onClick={onClose} aria-label="Close map">←</button>
        <span>Confirm delivery location</span>
      </div>
      <div className="swm-map-wrap">
        <div className="swm-map" ref={holderRef} />
        <div className="swm-hint">Move the map to place the pin on your doorstep</div>
        <div className="swm-pin-shadow" aria-hidden="true" />
        <div className={`swm-pin ${moving ? 'moving' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 36 48"><path d="M18 0C8 0 0 8 0 18c0 13 18 30 18 30s18-17 18-30C36 8 28 0 18 0z" fill="#E5484D" /><circle cx="18" cy="18" r="7" fill="#fff" /></svg>
        </div>
        <button type="button" className="swm-gps" disabled={detecting} onClick={() => { setWantGps(true); detectLocation(); }}>{detecting ? 'Finding you…' : '◎ Use my location'}</button>
      </div>
      <div className="swm-foot">
        <div className="swm-coords">Pin: {center.lat.toFixed(5)}, {center.lng.toFixed(5)}</div>
        {error && <div className="sw-err" role="alert">{error}</div>}
        <button type="button" className="sw-cta" disabled={moving} onClick={() => onConfirm({ lat: round6(center.lat), lng: round6(center.lng) })}>Confirm location</button>
      </div>
    </div>
  );
}

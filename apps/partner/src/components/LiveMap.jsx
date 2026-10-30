import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
// Map tiles come from public OpenStreetMap servers (light use only). For production traffic swap TILE_URL for a paid/self-hosted provider.
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const dot = (cls) => L.divIcon({ className: "", html: `<span class="pin ${cls}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] });

export default function LiveMap({ rider, pharmacy, customer, height = 220 }) {
  const el = useRef(null), map = useRef(null), layers = useRef({});
  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([34.08, 74.79], 13);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
    const t = setTimeout(() => map.current?.invalidateSize(), 200);
    return () => { clearTimeout(t); map.current?.remove(); map.current = null; layers.current = {}; };
  }, []);
  useEffect(() => {
    const m = map.current; if (!m) return;
    const pts = [];
    const put = (key, p, cls) => {
      if (!p || p.lat == null || p.lng == null) { layers.current[key]?.remove(); delete layers.current[key]; return; }
      const ll = [p.lat, p.lng]; pts.push(ll);
      if (layers.current[key]) layers.current[key].setLatLng(ll); else layers.current[key] = L.marker(ll, { icon: dot(cls), keyboard: false }).addTo(m);
    };
    put("rider", rider, "rider"); put("pharmacy", pharmacy, "pharmacy"); put("customer", customer, "customer");
    if (pts.length > 1) m.fitBounds(pts, { padding: [30, 30], maxZoom: 16 }); else if (pts.length === 1) m.setView(pts[0], 15);
  }, [rider?.lat, rider?.lng, pharmacy?.lat, pharmacy?.lng, customer?.lat, customer?.lng]);
  return <div ref={el} className="map" style={{ height }} role="img" aria-label="Live map" />;
}

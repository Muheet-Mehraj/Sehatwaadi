import { useEffect, useState } from "react";
export function useOnline() {
  const [on, setOn] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => { const up = () => setOn(true), down = () => setOn(false); window.addEventListener("online", up); window.addEventListener("offline", down); return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); }; }, []);
  return on;
}

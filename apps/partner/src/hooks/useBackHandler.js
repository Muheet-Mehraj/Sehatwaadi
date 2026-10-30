import { useEffect, useRef } from "react";
import { pushBackHandler } from "../services/backStack.js";
/** While `active`, the Android back button calls `handler` (topmost active layer wins). */
export function useBackHandler(active, handler) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => { if (!active) return undefined; return pushBackHandler(() => ref.current && ref.current()); }, [active]);
}

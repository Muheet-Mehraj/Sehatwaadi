import { useCallback, useEffect, useRef, useState } from 'react';

const LOCK_MS = 800;   // after a tap on the sidebar, ignore the observer while the smooth scroll plays out (no flicker)

/**
 * Scroll-spy for the dual-pane layout. Sections inside `containerRef` carry data-spy-key="<key>".
 * The "active" section is the first one (in `keys` order) crossing the band just under the top bar.
 */
export function useScrollSpy({ containerRef, keys, offsetTop, enabled = true }) {
  const [activeKey, setActiveKey] = useState(keys[0] || null);
  const visible = useRef(new Map());
  const locked = useRef(false);
  const lockTimer = useRef(null);
  const signature = keys.join('|');

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || keys.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;
    visible.current.clear();

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => visible.current.set(entry.target.dataset.spyKey, entry.isIntersecting));
      if (locked.current) return;
      const first = keys.find((key) => visible.current.get(key));
      if (first) setActiveKey(first);
    }, { rootMargin: `-${offsetTop}px 0px -65% 0px`, threshold: 0 });

    container.querySelectorAll('[data-spy-key]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, offsetTop, enabled, containerRef]);

  // If the active section disappears (a filter removed it), fall back to the first one.
  useEffect(() => {
    if (keys.length > 0 && !keys.includes(activeKey)) setActiveKey(keys[0]);
  }, [signature, activeKey, keys]);

  useEffect(() => () => clearTimeout(lockTimer.current), []);

  const scrollToSection = useCallback((key) => {
    const el = containerRef.current?.querySelector(`[data-spy-key="${key}"]`);
    if (!el) return;
    setActiveKey(key);
    locked.current = true;
    clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => { locked.current = false; }, LOCK_MS);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [containerRef]);

  return { activeKey, scrollToSection };
}

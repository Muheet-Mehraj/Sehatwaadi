import React, { memo, useEffect, useRef } from 'react';
import '../../assets/catalog.css';

/** Sticky left pane. Keeps the active category centred in view as the right pane scrolls. */
function CategorySidebar({ items, activeKey, onSelect }) {
  const navRef = useRef(null);

  useEffect(() => {
    const nav = navRef.current;
    const active = nav && nav.querySelector('[aria-current="true"]');
    if (!active || !nav.scrollTo) return;
    nav.scrollTo({ top: active.offsetTop - (nav.clientHeight - active.clientHeight) / 2, behavior: 'smooth' });
  }, [activeKey]);

  return (
    <nav className="swd-side" ref={navRef} aria-label="Categories">
      {items.map((category) => {
        const active = category.key === activeKey;
        return (
          <button key={category.key} type="button" className={`swd-cat ${active ? 'on' : ''}`}
            aria-current={active ? 'true' : undefined} onClick={() => onSelect(category.key)}>
            <span className="swd-tile" style={{ '--tile': category.color }}>{category.icon}</span>
            <span className="swd-cat-name">{category.name}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default memo(CategorySidebar);

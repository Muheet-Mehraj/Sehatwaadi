import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { dedupeMedicines, isRx } from '../utils/helpers';
import { hapticTap } from '../utils/native';
import { useCart } from '../context/CartContext';
import { useActiveOrder, describeActiveOrder } from '../context/ActiveOrderContext';
import { useScrollSpy } from '../hooks/useScrollSpy';
import TopBar from '../components/layout/TopBar';
import CategorySidebar from '../components/catalog/CategorySidebar';
import ProductCard from '../components/common/ProductCard';
import KashmirFooter from '../components/common/KashmirFooter';
import { FALLBACK_CATEGORIES } from '../data/categories';
import '../assets/catalog.css';

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'otc', label: 'No prescription', test: (m) => !isRx(m) },
  { key: 'rx', label: 'Rx medicines', test: (m) => isRx(m) },
  { key: 'u100', label: 'Under ₹100', test: (m) => Number(m.price) > 0 && Number(m.price) <= 100 },
];
const ESSENTIALS = { key: 'essentials', name: 'Essentials', icon: '🛍️', color: '#E9F7EC' };
const DEFAULT_TOPBAR_PX = 80;

// Coming back from a product page should not reload the catalog or lose your place.
let homeCache = null;
// eslint-disable-next-line react-refresh/only-export-components
export const resetHomeCache = () => { homeCache = null; };

/**
 * One list of sections for the right pane. A medicine appears once, in the first section that claims it
 * (batch rows and keyword overlaps never repeat), and the quick filter is applied before that.
 */
function buildSections(home, predicate) {
  if (!home) return [];
  const seenIds = new Set();
  const seenNames = new Set();
  const groups = [{ ...ESSENTIALS, items: home.essentials }, ...home.categories];
  return groups
    .map((group) => ({
      key: group.key, name: group.name, icon: group.icon, color: group.color,
      items: dedupeMedicines(group.items).filter((m) => {
        const name = String(m.name).toLowerCase();
        if (!predicate(m) || seenIds.has(m.id) || seenNames.has(name)) return false;
        seenIds.add(m.id); seenNames.add(name);
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

const SkeletonGrid = () => <div className="swd-grid" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="swd-skel" />)}</div>;

export default function HomeScreen({ onOpenCart, onOpenOrders, onTrackOrder }) {
  const { cart, cartCount, cartTotal } = useCart();
  const { activeOrder } = useActiveOrder();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchTick, setSearchTick] = useState(0);
  const [slowLoad, setSlowLoad] = useState(false);
  const [home, setHome] = useState(() => (homeCache ? homeCache.home : null));
  const [homeState, setHomeState] = useState(() => (homeCache ? 'ready' : 'loading'));
  const [filterKey, setFilterKey] = useState('all');
  const [topbarPx, setTopbarPx] = useState(DEFAULT_TOPBAR_PX);
  const topbarRef = useRef(null);
  const mainRef = useRef(null);
  const searchSeq = useRef(0);
  const pendingScroll = useRef(null);   // a rail tap made during a search: scroll once the sections are back on screen

  const searching = query.trim().length >= 2;
  const predicate = useMemo(() => FILTERS.find((f) => f.key === filterKey).test, [filterKey]);

  // ---- catalog: one request for the whole home screen ----
  const loadHome = useCallback(async () => {
    setHomeState('loading');
    try {
      const data = await api.getCatalogHome();
      const next = { essentials: data.essentials || [], categories: data.categories || [] };
      homeCache = { home: next, scrollY: homeCache ? homeCache.scrollY : 0 };
      setHome(next);
      setHomeState('ready');
    } catch {
      setHome(null);
      setHomeState('error');
    }
  }, []);
  useEffect(() => { loadHome(); }, [loadHome]);

  const sections = useMemo(() => buildSections(home, predicate), [home, predicate]);
  const sectionKeys = useMemo(() => sections.map((s) => s.key), [sections]);
  const sidebarItems = home ? sections : FALLBACK_CATEGORIES;   // tiles stay usable even if the catalog is down

  useLayoutEffect(() => {
    if (homeCache && homeCache.scrollY) window.scrollTo?.(0, homeCache.scrollY);
    return () => { if (homeCache) homeCache.scrollY = window.scrollY || 0; };
  }, []);

  // ---- top bar height drives the sticky offsets and the scroll-spy band ----
  useLayoutEffect(() => {
    const measure = () => setTopbarPx(topbarRef.current?.offsetHeight || DEFAULT_TOPBAR_PX);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const { activeKey, scrollToSection } = useScrollSpy({ containerRef: mainRef, keys: sectionKeys, offsetTop: topbarPx, enabled: !searching });

  // ---- search (debounced; stale responses are ignored; a failed request is reported, never shown as "no results") ----
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setResults(null); setSearchFailed(false); return undefined; }
    const seq = ++searchSeq.current;
    setSearchFailed(false);
    const timer = setTimeout(async () => {
      try {
        const rows = await api.searchMedicines(text);
        if (seq !== searchSeq.current) return;
        setResults(dedupeMedicines(Array.isArray(rows) ? rows : []).filter(predicate));
      } catch {
        if (seq !== searchSeq.current) return;
        setResults([]);
        setSearchFailed(true);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, predicate, searchTick]);

  // The Hub can take a moment to wake up on first use: say so instead of showing a silent skeleton.
  useEffect(() => {
    if (homeState !== 'loading') { setSlowLoad(false); return undefined; }
    const timer = setTimeout(() => setSlowLoad(true), 6000);
    return () => clearTimeout(timer);
  }, [homeState]);

  const handleSelect = useCallback((key) => {
    hapticTap();
    if (sectionKeys.includes(key)) {
      if (searching) { pendingScroll.current = key; setQuery(''); } else scrollToSection(key);
      return;
    }
    const fallback = FALLBACK_CATEGORIES.find((c) => c.key === key);   // catalog unavailable: search by the category's keyword
    if (fallback) setQuery(fallback.q);
  }, [sectionKeys, scrollToSection, searching]);

  useEffect(() => {
    const key = pendingScroll.current;
    if (searching || !key || !sectionKeys.includes(key)) return;
    pendingScroll.current = null;
    scrollToSection(key);
  }, [searching, sectionKeys, scrollToSection]);

  const showRx = useCallback(() => { hapticTap(); setQuery(''); setFilterKey('rx'); }, []);
  const clearSearch = useCallback((value) => setQuery(value), []);

  return (
    <div className="swd-app" style={{ '--topbar-h': `${topbarPx}px` }}>
      <TopBar query={query} onQueryChange={clearSearch} onOpenCart={onOpenCart} onOpenOrders={onOpenOrders} barRef={topbarRef} />
      <div className="swd-spacer" />

      <div className="swd-body">
        <CategorySidebar items={sidebarItems} activeKey={searching ? null : activeKey} onSelect={handleSelect} />

        <main className="swd-main" ref={mainRef}>
          {activeOrder && (
            <button className="swd-track" onClick={() => { hapticTap(); onTrackOrder?.(activeOrder.id); }}>
              <span className="swd-track-icon">🛵</span>
              <span className="swd-track-text"><b>{describeActiveOrder(activeOrder)}</b><small>Order #{String(activeOrder.id).slice(0, 8).toUpperCase()}</small></span>
              <span className="swd-track-go">Track ›</span>
            </button>
          )}

          {searching && (
            <section>
              <h2 className="swd-sec-title">Results for “{query.trim()}”</h2>
              {results === null && <SkeletonGrid />}
              {searchFailed && (
                <div className="swd-empty">
                  <p>Couldn't search right now. Check your connection.</p>
                  <button className="swd-retry" onClick={() => setSearchTick((n) => n + 1)}>Retry</button>
                </div>
              )}
              {!searchFailed && results && results.length === 0 && <p className="swd-empty">No medicines found. Try the brand or generic name.</p>}
              {results && results.length > 0 && (
                <div className="swd-grid">{results.map((m) => <ProductCard key={m.id} medicine={m} qty={cart[m.id] || 0} />)}</div>
              )}
            </section>
          )}

          {!searching && (
            <>
              <div className="swd-snap" aria-label="Offers">
                <button className="swd-banner swd-banner--green" onClick={() => sectionKeys[0] && scrollToSection(sectionKeys[0])}>
                  <b>Medicines at your door</b><small>From licensed pharmacies near you</small><span>Order now</span>
                </button>
                <button className="swd-banner swd-banner--orange" onClick={showRx}>
                  <b>Have a prescription?</b><small>Upload it at checkout. A pharmacist verifies it</small><span>Shop Rx medicines</span>
                </button>
                <button className="swd-banner swd-banner--blue" onClick={() => handleSelect('herbal')}>
                  <b>Made in Kashmir 🏔️</b><small>Himalayan herbal care from the valley</small><span>Explore</span>
                </button>
              </div>

              <div className="swd-pills" role="group" aria-label="Quick filters">
                {FILTERS.map((f) => (
                  <button key={f.key} className={`swd-pill ${filterKey === f.key ? 'on' : ''}`} aria-pressed={filterKey === f.key} onClick={() => setFilterKey(f.key)}>{f.label}</button>
                ))}
              </div>

              {homeState === 'loading' && <SkeletonGrid />}
              {homeState === 'loading' && slowLoad && <p className="swd-slow">Connecting to SehatWaadi… the first load can take a moment.</p>}
              {homeState === 'error' && (
                <div className="swd-empty">
                  <p>Couldn't load the catalog. Check your connection.</p>
                  <button className="swd-retry" onClick={loadHome}>Retry</button>
                  <p className="swd-hint">You can still search above or tap a category.</p>
                </div>
              )}
              {homeState === 'ready' && sections.length === 0 && <p className="swd-empty">Nothing matches this filter right now.</p>}

              {sections.map((section) => (
                <section key={section.key} className="swd-section" data-spy-key={section.key}>
                  <h2 className="swd-sec-title">{section.icon} {section.name}<span className="swd-count">{section.items.length}</span></h2>
                  <div className="swd-grid">
                    {section.items.map((m) => <ProductCard key={m.id} medicine={m} qty={cart[m.id] || 0} />)}
                  </div>
                </section>
              ))}
            </>
          )}

          <KashmirFooter />
        </main>
      </div>

      {cartCount > 0 && (
        <button className="sw-bar" onClick={() => { hapticTap(); onOpenCart(); }}>
          <b>{cartCount} item{cartCount > 1 ? 's' : ''} · ₹{Math.round(cartTotal * 100) / 100}</b>
          <b>View cart ›</b>
        </button>
      )}
    </div>
  );
}

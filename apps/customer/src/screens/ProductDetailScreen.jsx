import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useCart } from '../context/CartContext';
import { useNav } from '../context/NavContext';
import { useBackHandler } from '../hooks/useBackHandler';
import { formatINR } from '../utils/helpers';
import ProductBasics from '../components/product/ProductBasics';
import SubstituteSection from '../components/product/SubstituteSection';
import CompareCards from '../components/product/CompareCards';
import ProductSheet from '../components/product/ProductSheet';
import PromoBanner from '../components/product/PromoBanner';
import AddControl from '../components/product/AddControl';
import ProductCard from '../components/common/ProductCard';
import '../assets/product-detail.css';

export default function ProductDetailScreen({ medicineId, onBack }) {
  const { cartCount, cart } = useCart();
  const { openCart, goHome } = useNav();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [compact, setCompact] = useState(false);
  const [sheetId, setSheetId] = useState(null);
  const addRowRef = useRef(null);

  useBackHandler(true, onBack);

  const load = useCallback(async () => {
    setFailed(false);
    setData(null);
    try { setData(await api.getMedicine(medicineId)); } catch { setFailed(true); }
  }, [medicineId]);
  useEffect(() => { load(); window.scrollTo?.({ top: 0 }); }, [load]);

  // Once the main ADD row scrolls out of view the header shows name + price + ADD, as in the reference app.
  useEffect(() => {
    const row = addRowRef.current;
    if (!row || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => setCompact(!entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    observer.observe(row);
    return () => observer.disconnect();
  }, [data]);

  const medicine = data && data.medicine;
  const substitute = data && data.substitute;

  return (
    <div className="pd-screen">
      <header className="pd-bar">
        <div className="pd-bar-in">
          <button type="button" className="pd-icon-btn" onClick={onBack} aria-label="Back">←</button>
          {compact && medicine ? (
            <>
              <div className="pd-bar-mini"><b>{medicine.name}</b><span>{formatINR(medicine.price)}{medicine.discountPercent > 0 ? ` · ${medicine.discountPercent}% off` : ''}</span></div>
              <AddControl item={medicine} />
            </>
          ) : (
            <>
              <span className="pd-bar-title">Item details</span>
              <button type="button" className="pd-icon-btn" onClick={goHome} aria-label="Search">🔍</button>
              <button type="button" className="pd-icon-btn" onClick={openCart} aria-label={`Cart, ${cartCount} item${cartCount === 1 ? '' : 's'}`}>
                🛍️{cartCount > 0 && <span className="pd-badge">{cartCount}</span>}
              </button>
            </>
          )}
        </div>
      </header>
      <PromoBanner />

      <div className="pd-wrap">
        {!data && !failed && <><div className="pd-skel" aria-hidden="true" /><div className="pd-skel" aria-hidden="true" /></>}
        {failed && (
          <div className="pd-error"><p>Couldn't load this medicine. Check your connection.</p><button type="button" className="swd-retry" onClick={load}>Retry</button></div>
        )}

        {medicine && (
          <ProductBasics medicine={medicine} addRowRef={addRowRef}>
            {substitute && (
              <>
                <SubstituteSection substitute={substitute} onOpen={setSheetId} />
                <CompareCards medicine={medicine} substitute={substitute} />
              </>
            )}
          </ProductBasics>
        )}

        {data && data.related && data.related.length > 0 && (
          <section className="pd-related" aria-label={data.relatedTitle || 'Similar medicines'}>
            <h2 className="pd-h2">{data.relatedTitle || 'Similar medicines'}</h2>
            <div className="pd-rail">
              {data.related.map((item) => (
                <div key={item.id}>
                  <ProductCard medicine={item} qty={cart[item.id] || 0} />
                  {item.hasSubstitute && <div className="pd-subtag">Substitute available</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {medicine && <p className="pd-disclaimer">This information is for general guidance and does not replace advice from your doctor or pharmacist. Substitutes are suggested only when the salt and strength are identical; confirm with your pharmacist, especially for prescription medicines.</p>}
      </div>

      {sheetId && <ProductSheet medicineId={sheetId} onClose={() => setSheetId(null)} />}
    </div>
  );
}

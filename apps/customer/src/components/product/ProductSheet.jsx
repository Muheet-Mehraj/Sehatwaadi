import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useBackHandler } from '../../hooks/useBackHandler';
import ProductBasics from './ProductBasics';
import '../../assets/product-detail.css';

/** Bottom sheet with a medicine's full details (used when tapping the recommended substitute). */
export default function ProductSheet({ medicineId, onClose }) {
  const [medicine, setMedicine] = useState(null);
  const [failed, setFailed] = useState(false);
  useBackHandler(true, onClose);

  useEffect(() => {
    let alive = true;
    api.getMedicine(medicineId).then((r) => { if (alive) setMedicine(r.medicine); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [medicineId]);

  return (
    <>
      <div className="pd-sheet-back" onClick={onClose} />
      <div className="pd-sheet" role="dialog" aria-modal="true" aria-label="Item details">
        <div className="pd-sheet-grab" />
        <div className="pd-sheet-head"><span>Item details</span><button type="button" className="sw-x" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="pd-sheet-body">
          {!medicine && !failed && <div className="pd-skel" aria-hidden="true" />}
          {failed && <p className="pd-error">Couldn't load this medicine. Check your connection.</p>}
          {medicine && <ProductBasics medicine={medicine} />}
        </div>
      </div>
    </>
  );
}

import React, { memo } from 'react';
import { useCartActions } from '../../context/CartContext';
import { useNav } from '../../context/NavContext';
import { isRx, formatINR, captionFor } from '../../utils/helpers';
import { hapticTap } from '../../utils/native';
import { QtyStepper } from './UIComponents';
import MedicineThumbnail from './MedicineThumbnail';
import '../../assets/catalog.css';

// Re-renders only when ITS medicine or ITS quantity changes: cart actions and navigation come from stable contexts.
function ProductCard({ medicine, qty }) {
  const { addToCart, removeFromCart } = useCartActions();
  const { openProduct } = useNav();
  const price = Number(medicine.price) || 0;
  const mrp = Number(medicine.mrp) || 0;
  const discount = mrp > price && price > 0 ? Math.round((1 - price / mrp) * 100) : 0;

  return (
    <article className="swp-card">
      <button type="button" className="swp-link" aria-label={`View ${medicine.name}`} onClick={() => { hapticTap(); openProduct(medicine.id); }}>
        <span className="swp-thumb"><MedicineThumbnail medicine={medicine} size={80} /></span>
        {isRx(medicine) && <span className="swp-rx">Rx Required</span>}
        <span className="swp-name">{medicine.name}</span>
        <span className="swp-cap">{captionFor(medicine)}</span>
      </button>
      <div className="swp-foot">
        <div className="swp-prices">
          <span className="swp-price">{formatINR(price)}</span>
          {discount > 0 && <span className="swp-mrp">{formatINR(mrp)}</span>}
          {discount > 0 && <span className="swp-off">{discount}% OFF</span>}
        </div>
        <QtyStepper qty={qty} onAdd={() => addToCart(medicine)} onRemove={() => removeFromCart(medicine)} />
      </div>
    </article>
  );
}

export default memo(ProductCard);

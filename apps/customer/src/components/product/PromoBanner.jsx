import React from 'react';
import { promoText } from '../../config/app';

/** Soft-green strip under the header. Shows only when a real promotion is configured (VITE_PROMO_TEXT). */
export default function PromoBanner({ text = promoText() }) {
  if (!text) return null;
  return <div className="pd-promo" role="note"><div className="pd-promo-in">🏷️ {text}</div></div>;
}

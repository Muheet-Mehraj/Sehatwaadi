import React from 'react';
import { isRx, formatINR } from '../../utils/helpers';
import { formatSalt } from '../../utils/product';
import ImageCarousel from './ImageCarousel';
import AddControl from './AddControl';
import InfoAccordions from './InfoAccordions';

/** Photos, name/manufacturer/pack, prices + ADD, then (children), composition and the accordions. Used by the product screen and the substitute sheet. */
export default function ProductBasics({ medicine, addRowRef, children }) {
  const m = medicine;
  const thumbMeta = { name: m.name, schedule_class: m.scheduleClass };
  return (
    <>
      <ImageCarousel images={m.images} medicine={thumbMeta} />

      <section className="pd-info">
        <h1 className="pd-name">{m.name}</h1>
        {m.manufacturer && <p className="pd-manu">{m.manufacturer}</p>}
        <div className="pd-tags">
          {m.unitCount && <span className="pd-chip">Strip of {m.unitCount} {m.unitLabel}</span>}
          {isRx({ schedule_class: m.scheduleClass }) && <span className="pd-rx">Rx Required</span>}
        </div>
        <div className="pd-addrow" ref={addRowRef}>
          <div className="pd-prices">
            {m.mrp && <div><span className="pd-mrp">MRP {formatINR(m.mrp)}</span>{m.discountPercent > 0 && <span className="pd-off">{m.discountPercent}% OFF</span>}</div>}
            <div className="pd-price">{formatINR(m.price)}</div>
            {m.pricePerUnit && <div className="pd-unit">{formatINR(m.pricePerUnit)}/{m.unitLabel}</div>}
          </div>
          <AddControl item={m} />
        </div>
      </section>

      {children}

      <section className="pd-card pd-composition" aria-label="Composition">
        <span className="pd-card-icon" aria-hidden="true">⚗️</span>
        <div>
          <div className="pd-card-title">Composition</div>
          <div className="pd-card-text">{m.name}</div>
          {m.composition.length > 0
            ? m.composition.map((c, i) => <div className="pd-card-text pd-salt" key={i}>{formatSalt(c)}</div>)
            : <div className="pd-card-text pd-muted">Composition not listed yet</div>}
        </div>
      </section>
      {m.storage && <div className="pd-card pd-storage"><span aria-hidden="true">🌡️</span> {m.storage}</div>}

      <InfoAccordions medicine={m} />
    </>
  );
}

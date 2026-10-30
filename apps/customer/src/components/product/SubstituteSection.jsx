import React from 'react';
import { formatINR } from '../../utils/helpers';
import { formatPercent, formatSalt } from '../../utils/product';
import MedicineThumbnail from '../common/MedicineThumbnail';
import AddControl from './AddControl';

/**
 * The purple "lower price substitute" block. It is only rendered when the Hub has verified the substitute:
 * identical salts and strengths, a recorded source, and a genuinely lower price per unit in OUR catalog.
 */
export default function SubstituteSection({ substitute, onOpen }) {
  const s = substitute;
  const thumb = { name: s.name, image_url: s.images[0] && s.images[0].url, schedule_class: s.scheduleClass };
  return (
    <section className="pd-sub" aria-label="Recommended substitute">
      <div className="pd-sub-banner">{`💊 ${formatPercent(s.savingsPercent)}% Lower Price Substitute`}</div>
      {s.manufacturer && <div className="pd-sub-by">RECOMMENDED SUBSTITUTE BY <b>{s.manufacturer.toUpperCase()}</b> <span className="pd-verified" aria-label="Verified">✓</span></div>}

      <div className="pd-sub-card">
        <button type="button" className="pd-sub-open" onClick={() => onOpen(s.id)} aria-label={`View ${s.name}`}>
          <span className="pd-sub-thumb"><MedicineThumbnail medicine={thumb} size={56} /></span>
          <span className="pd-sub-text"><b>{s.name}</b>{s.manufacturer && <small>{s.manufacturer}</small>}</span>
        </button>
        <div className="pd-sub-row">
          <div className="pd-sub-price">
            <b>{formatINR(s.price)}</b>
            {s.pricePerUnit && <span className="pd-sub-unit">{formatINR(s.pricePerUnit)}</span>}
            {s.unitCount && <span className="pd-chip">Strip of {s.unitCount} {s.unitLabel}</span>}
          </div>
          <AddControl item={s} />
        </div>
      </div>

      <div className="pd-same">⚖️ EXACT SAME COMPOSITION{s.composition.length > 0 && <span>{s.composition.map(formatSalt).join(' + ')}</span>}</div>
    </section>
  );
}

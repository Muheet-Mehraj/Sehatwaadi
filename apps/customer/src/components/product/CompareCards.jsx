import React from 'react';
import { formatINR } from '../../utils/helpers';
import { formatPercent, formatSalt } from '../../utils/product';
import MedicineThumbnail from '../common/MedicineThumbnail';

function Side({ item, substitute }) {
  const thumb = { name: item.name, image_url: item.images[0] && item.images[0].url, schedule_class: item.scheduleClass };
  return (
    <article className={`pd-ccard ${substitute ? 'pd-ccard--sub' : ''}`} aria-label={substitute ? 'Substitute medicine' : 'Your medicine'}>
      {substitute && <span className="pd-ribbon">Substitute</span>}
      <div className="pd-cthumb"><MedicineThumbnail medicine={thumb} size={72} /></div>
      <div className="pd-cname">{item.name}</div>
      <div className="pd-crow">{item.manufacturer || 'Manufacturer not listed'}</div>
      {item.regulatoryStatus && <div className="pd-crow pd-crow--ok">✓ {item.regulatoryStatus}</div>}
      {item.composition.map((c, i) => <div className="pd-crow" key={i}>{formatSalt(c)}</div>)}
      <div className="pd-crow pd-cunit">{item.pricePerUnit ? `${formatINR(item.pricePerUnit)}/${item.unitLabel === 'Units' ? 'unit' : item.unitLabel}` : ''}</div>
      {substitute && <div className="pd-cheaper">{formatPercent(item.savingsPercent)}% cheaper</div>}
    </article>
  );
}

/** Side by side: your medicine on the left, the verified substitute (purple border) on the right, and the polygon "100% match" badge floating between them. */
export default function CompareCards({ medicine, substitute }) {
  return (
    <section className="pd-compare" aria-label="Compare your medicine">
      <h2 className="pd-h2">Compare your medicine</h2>
      <div className="pd-cgrid">
        <Side item={medicine} />
        <div className="pd-match" role="img" aria-label={`${substitute.matchPercent}% match`}>
          <span className="pd-match-tick" aria-hidden="true">✓</span>
          <span className="pd-match-pct" aria-hidden="true">{substitute.matchPercent}%</span>
          <span className="pd-match-word" aria-hidden="true">match</span>
        </div>
        <Side item={substitute} substitute />
      </div>
    </section>
  );
}

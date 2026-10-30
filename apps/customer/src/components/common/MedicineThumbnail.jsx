import React, { useState } from 'react';

// Real photo when the catalog has one (image_url); otherwise an illustrated pack, so a card is never blank.
// The caller owns the square container (see .swp-thumb); this fills it.
const PALETTE = ['#0C831F', '#2F80ED', '#F2994A', '#9B51E0', '#E5484D', '#0E9AA7'];
const RX_CLASSES = ['H', 'H1', 'X'];

const hash = (text) => { let h = 0; for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

export function kindFor(name = '') {
  const n = name.toLowerCase();
  if (/thermometer|oximeter|monitor|glucometer|nebuli[sz]er|\bbp\b|device|stethoscope/.test(n)) return 'device';
  if (/insulin|inject|vial|syringe/.test(n)) return 'injection';
  if (/bandage|plaster|gauze|cotton|band-aid|crepe/.test(n)) return 'bandage';
  if (/\bors\b|sachet|powder|granules/.test(n)) return 'sachet';
  if (/drop|eye|ear |nasal/.test(n)) return 'drops';
  if (/cream|ointment|gel|lotion|balm|paste/.test(n)) return 'tube';
  if (/syrup|syp|suspension|liquid|cough|antiseptic|solution|tonic|sanitizer/.test(n)) return 'syrup';
  if (/capsule|\bcap\b|softgel/.test(n)) return 'capsule';
  return 'tablet';
}

const STROKE = '#CBD5E1';

function PackArt({ kind, color, band }) {
  const shapes = {
    tablet: (<><rect x="12" y="26" width="76" height="48" rx="8" fill="#fff" stroke={STROKE} strokeWidth="2" /><rect x="12" y="26" width="76" height="10" rx="5" fill={band} />
      {[0, 1, 2].flatMap((i) => [0, 1].map((j) => <circle key={`${i}${j}`} cx={30 + i * 20} cy={47 + j * 14} r="6" fill={j ? '#F8FAFC' : color} stroke={STROKE} strokeWidth="1.5" />))}</>),
    capsule: (<g transform="rotate(-35 50 50)"><rect x="16" y="38" width="68" height="24" rx="12" fill="#fff" stroke={STROKE} strokeWidth="2" /><path d="M50 38h22a12 12 0 0 1 0 24H50z" fill={color} /><rect x="16" y="38" width="68" height="24" rx="12" fill="none" stroke="#94A3B8" strokeWidth="2" /></g>),
    syrup: (<><rect x="42" y="12" width="16" height="10" rx="2" fill={band} /><rect x="44" y="22" width="12" height="10" fill="#E2E8F0" /><rect x="28" y="32" width="44" height="58" rx="9" fill="#fff" stroke={STROKE} strokeWidth="2" /><rect x="28" y="50" width="44" height="22" fill={color} opacity=".9" /><path d="M50 54v14M43 61h14" stroke="#fff" strokeWidth="4" strokeLinecap="round" /></>),
    tube: (<><rect x="34" y="14" width="32" height="64" rx="5" fill="#fff" stroke={STROKE} strokeWidth="2" /><rect x="34" y="40" width="32" height="20" fill={color} /><rect x="38" y="78" width="24" height="12" rx="3" fill={band} /><path d="M34 14h32l-4-4H38z" fill={STROKE} /></>),
    drops: (<><rect x="40" y="10" width="20" height="16" rx="6" fill={band} /><path d="M44 26h12v8H44z" fill="#E2E8F0" /><rect x="30" y="34" width="40" height="54" rx="10" fill="#fff" stroke={STROKE} strokeWidth="2" /><path d="M50 46c6 8 9 12 9 17a9 9 0 0 1-18 0c0-5 3-9 9-17z" fill={color} /></>),
    injection: (<><rect x="22" y="40" width="40" height="20" rx="4" fill="#fff" stroke={STROKE} strokeWidth="2" /><rect x="22" y="40" width="20" height="20" fill={color} opacity=".85" /><rect x="62" y="46" width="22" height="8" fill="#94A3B8" /><rect x="84" y="49" width="10" height="2" fill="#94A3B8" /><rect x="14" y="34" width="8" height="32" rx="3" fill={band} /></>),
    device: (<><rect x="22" y="14" width="56" height="72" rx="12" fill="#fff" stroke={STROKE} strokeWidth="2" /><rect x="30" y="24" width="40" height="26" rx="5" fill="#0F172A" /><path d="M34 40l6-6 6 8 6-10 8 10" stroke="#34D399" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /><circle cx="50" cy="66" r="9" fill={color} /><circle cx="50" cy="66" r="3.5" fill="#fff" /></>),
    bandage: (<g transform="rotate(-30 50 50)"><rect x="10" y="36" width="80" height="28" rx="14" fill="#F8D7B5" stroke="#E0B88F" strokeWidth="2" /><rect x="38" y="36" width="24" height="28" fill="#fff" stroke="#E0B88F" strokeWidth="2" /></g>),
    sachet: (<><path d="M24 20h52v64H24z" fill="#fff" stroke={STROKE} strokeWidth="2" /><path d="M24 20l4-6 4 6 4-6 4 6 4-6 4 6 4-6 4 6 4-6 4 6 4-6 4 6" fill={band} stroke={band} strokeWidth="2" /><path d="M50 40c7 10 11 15 11 20a11 11 0 0 1-22 0c0-5 4-10 11-20z" fill={color} /></>),
  };
  return <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">{shapes[kind]}</svg>;
}

export default function MedicineThumbnail({ medicine, size = 80 }) {
  const [broken, setBroken] = useState(false);
  const url = medicine.image_url || medicine.imageUrl || medicine.image;

  if (url && !broken) {
    return <img className="swp-img" src={url} alt={medicine.name} width={size} height={size} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  const isRxPack = RX_CLASSES.includes(String(medicine.schedule_class || '').toUpperCase());
  const color = PALETTE[hash(medicine.name) % PALETTE.length];
  const kind = kindFor(medicine.name);
  return (
    <div className="swp-art" role="img" aria-label={medicine.name} data-kind={kind}>
      <PackArt kind={kind} color={color} band={isRxPack ? '#D9480F' : color} />
    </div>
  );
}

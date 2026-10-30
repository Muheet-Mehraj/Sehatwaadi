import React from 'react';

// Line-art skyline of the valley: Pir Panjal ridge, pines, a chinar leaf and a shikara on Dal Lake.
export default function KashmirFooter() {
  const line = { fill: 'none', stroke: 'var(--green, #0C831F)', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <footer className="swk" aria-label="Made in Kashmir">
      <style>{`
        .swk { margin-top:34px; padding:6px 0 calc(110px + env(safe-area-inset-bottom)); text-align:center; color:var(--green,#0C831F); }
        .swk svg { width:100%; max-width:760px; height:auto; display:block; margin:0 auto; opacity:.5; }
        .swk-t { font-weight:800; letter-spacing:.42em; font-size:.74rem; margin-top:-6px; opacity:.75; }
        .swk-s { color:var(--muted,#6B6B6B); font-size:.78rem; margin-top:8px; padding:0 20px; }
      `}</style>
      <svg viewBox="0 0 760 170" role="img" aria-label="Mountains, pine trees and a shikara boat on Dal Lake">
        <g {...line}>
          <path d="M0 118 L70 70 L108 96 L176 38 L236 92 L290 60 L352 104 L430 44 L500 98 L560 66 L630 108 L700 74 L760 112" />
          <path d="M176 38 l-14 26 l16 -6 l10 10 l10 -14 M430 44 l-12 24 l14 -6 l9 9 l10 -13" opacity=".7" />
          <path d="M0 122 Q95 112 190 122 T380 122 T570 122 T760 122" opacity=".55" />
          <path d="M96 118 l10 -30 l10 30 M104 118 l2 -14 M88 118 h36 M126 118 l8 -24 l8 24 M120 118 h30" />
          <path d="M600 118 l10 -30 l10 30 M592 118 h36 M628 118 l8 -22 l8 22 M622 118 h30" />
          <path d="M300 112 c18 -22 40 -14 46 4 c-12 2 -20 2 -26 -2 c-4 6 -12 8 -20 -2z M326 112 l0 12" />
          <path d="M392 150 q60 14 140 0 l-14 -16 h-112 z M462 134 v-28 M462 108 q22 4 34 26" />
          <path d="M60 150 q60 8 120 0 M560 156 q70 8 150 0 M240 160 q50 6 110 0" opacity=".5" />
        </g>
      </svg>
      <div className="swk-t">MADE IN KASHMIR</div>
      <div className="swk-s">Delivering health to every valley · Licensed pharmacies · Verified prescriptions</div>
    </footer>
  );
}

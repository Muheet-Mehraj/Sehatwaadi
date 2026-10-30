// "Made in Kashmir" background watermark: an original line-art scene (Pir Panjal ridgeline, chinar leaf, pines, a shikara on the lake)
// pinned to the bottom of every screen, faint enough to sit behind content. Pure SVG + CSS: no image files, no network, no JS.
export default function Watermark() {
  return (
    <div className="wm" aria-hidden="true">
      <svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMax meet" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
        {/* far ridgeline with snow caps */}
        <path d="M0 190 L70 128 L112 160 L190 82 L262 150 L318 112 L400 176 L486 96 L560 158 L630 118 L710 170 L760 140 L800 168" />
        <path d="M190 82 L168 106 L184 100 L196 112 L206 98 L224 110 L214 96 Z M486 96 L466 118 L480 112 L492 124 L504 110 L520 120 L506 106 Z" fill="currentColor" fillOpacity=".5" />
        {/* near hills */}
        <path d="M0 214 C90 170 150 182 230 206 C310 228 360 188 450 192 C540 196 610 232 700 200 C750 184 780 190 800 198" />
        {/* pines */}
        {[[60, 214], [92, 222], [722, 206], [756, 214]].map(([x, y]) => (
          <g key={x}><path d={`M${x} ${y} V${y - 12}`} /><path d={`M${x} ${y - 46} L${x - 13} ${y - 22} H${x + 13} Z M${x} ${y - 32} L${x - 17} ${y - 8} H${x + 17} Z`} /></g>
        ))}
        {/* chinar leaf (five-pointed, with veins) */}
        <g transform="translate(612 92) rotate(-14)">
          <path d="M0 -34 L9 -18 L26 -22 L19 -6 L34 2 L16 8 L18 26 L2 16 L0 40 L-2 16 L-18 26 L-16 8 L-34 2 L-19 -6 L-26 -22 L-9 -18 Z" fill="currentColor" fillOpacity=".4" />
          <path d="M0 -26 V40 M0 2 L-20 -14 M0 2 L20 -14 M0 8 L-16 14 M0 8 L16 14" strokeWidth="1.4" />
        </g>
        {/* lake and shikara */}
        <path d="M0 236 H800" strokeOpacity=".5" />
        <path d="M250 246 Q300 262 350 246 M430 250 Q480 266 530 250 M120 252 Q160 264 200 252" strokeOpacity=".5" />
        <g transform="translate(330 232)">
          <path d="M-70 8 Q-4 22 66 6 L52 -6 H-56 Z" fill="currentColor" fillOpacity=".5" />
          <path d="M-34 -6 V-30 Q4 -42 40 -30 V-6" />
          <path d="M-34 -30 Q4 -44 40 -30 M-20 -6 V-26 M-4 -6 V-34 M12 -6 V-34 M28 -6 V-28" strokeWidth="1.4" />
          <path d="M-70 8 Q-84 -4 -76 -18" />
        </g>
        <path d="M280 256 Q330 268 392 252" strokeOpacity=".5" />
        <text x="400" y="292" textAnchor="middle" fill="currentColor" stroke="none" fontSize="21" fontWeight="800" letterSpacing="9" style={{ fontFamily: "system-ui, sans-serif" }}>MADE IN KASHMIR</text>
      </svg>
    </div>
  );
}

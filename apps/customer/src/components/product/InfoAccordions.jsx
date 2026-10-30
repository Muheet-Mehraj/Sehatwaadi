import React, { useState } from 'react';

const SECTIONS = [
  { key: 'highlights', title: 'Product highlights', icon: '⭐', field: 'highlights' },
  { key: 'ingredients', title: 'Ingredients', icon: '🧪', field: 'ingredients' },
  { key: 'uses', title: 'Key uses', icon: '🎯', field: 'keyUses' },
  { key: 'how', title: 'How to use', icon: '📖', field: 'howToUse' },
  { key: 'safety', title: 'Safety information', icon: '🛡️', field: 'safety' },
];

const lineText = (entry) => (typeof entry === 'string' ? entry : [entry.title, entry.text].filter(Boolean).join(': '));

/** Vertically stacked expandable sections. One open at a time keeps the page short. */
export default function InfoAccordions({ medicine }) {
  const [openKey, setOpenKey] = useState(null);
  return (
    <div className="pd-acc" role="list">
      {SECTIONS.map((section) => {
        const lines = (medicine[section.field] || []).map(lineText).filter(Boolean);
        const open = openKey === section.key;
        return (
          <div className="pd-acc-item" role="listitem" key={section.key}>
            <button type="button" className="pd-acc-head" aria-expanded={open} aria-controls={`pd-acc-${section.key}`} onClick={() => setOpenKey(open ? null : section.key)}>
              <span className="pd-acc-icon" aria-hidden="true">{section.icon}</span>
              <span className="pd-acc-title">{section.title}</span>
              <span className={`pd-chev ${open ? 'open' : ''}`} aria-hidden="true">⌄</span>
            </button>
            {open && (
              <div className="pd-acc-body" id={`pd-acc-${section.key}`}>
                {lines.length > 0
                  ? <ul>{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
                  : <p className="pd-muted">This information hasn't been added yet. Ask your pharmacist or read the pack leaflet.</p>}
                {medicine.contentSource && section.key !== 'ingredients' && <p className="pd-source">Source: {medicine.contentSource}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

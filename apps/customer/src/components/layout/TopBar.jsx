import React from 'react';
import { SearchBar } from '../common/UIComponents';
import HeaderActions from '../auth/HeaderActions';
import AddressSelector from '../checkout/AddressSelector';
import '../../assets/catalog.css';

/** Fixed header: logo, delivery location (AddressSelector reads useLocation itself), search, and Orders / Account / Cart. */
export default function TopBar({ query, onQueryChange, onOpenCart, onOpenOrders, barRef }) {
  return (
    <header className="swd-top" ref={barRef}>
      <div className="swd-top-in">
        <div className="swd-logo" aria-label="SehatWaadi">
          <span className="swd-mark">+</span>
          <span className="swd-word">SehatWaadi</span>
        </div>
        <div className="swd-loc"><AddressSelector /></div>
        <div className="swd-search"><SearchBar value={query} onChange={onQueryChange} /></div>
        <div className="swd-actions"><HeaderActions onOpenCart={onOpenCart} onOpenOrders={onOpenOrders} /></div>
      </div>
    </header>
  );
}

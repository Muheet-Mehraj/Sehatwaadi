// App-level settings. Functions (not constants) so a build setting or a test can change them without a reload.
export const ONGOING_ORDER_MESSAGE = 'You have an ongoing order. Please wait for it to be completed before placing a new one.';

// 'full'     = while an order is in progress the customer is held on the order-tracking screen (Rapido style).
// 'checkout' = they can still browse and fill a cart, but checkout stays closed. Set VITE_ORDER_LOCK_MODE=checkout to switch.
export const lockMode = () => (import.meta.env?.VITE_ORDER_LOCK_MODE === 'checkout' ? 'checkout' : 'full');

// A promo strip under the product header. Empty (hidden) unless you set VITE_PROMO_TEXT, so the app never advertises an offer that isn't real.
export const promoText = () => import.meta.env?.VITE_PROMO_TEXT || '';

// Map tiles for the delivery pin. The public OpenStreetMap server is for light use only: point this at a paid tile provider in production.
export const mapTileUrl = () => import.meta.env?.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors';
export const DEFAULT_MAP_CENTER = { lat: 34.0837, lng: 74.7973 };   // Srinagar

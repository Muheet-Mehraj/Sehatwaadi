import React, { useEffect, useMemo, useState } from 'react';
import { useCart } from '../../context/CartContext';
import { useLocation } from '../../context/LocationContext';
import { useAuth } from '../../context/AuthContext';
import { useAuthUI } from '../../context/AuthUIContext';
import { useNetwork } from '../../context/NetworkContext';
import { useActiveOrder, describeActiveOrder } from '../../context/ActiveOrderContext';
import { ONGOING_ORDER_MESSAGE } from '../../config/app';
import { useBackHandler } from '../../hooks/useBackHandler';
import { api } from '../../api/client';
import '../../assets/catalog.css';
import { isRx, formatINR, captionFor } from '../../utils/helpers';
import { hapticSuccess, hapticError } from '../../utils/native';
import { QtyStepper, ErrorBanner } from '../common/UIComponents';
import MedicineThumbnail from '../common/MedicineThumbnail';
import AddressSelector from '../checkout/AddressSelector';
import PinpointSheet from '../checkout/PinpointSheet';
import PrescriptionUpload from '../checkout/PrescriptionUpload';

const DELIVERY_FEE = 0;
const HANDLING_FEE = 0;
const ORDER_RADIUS_KM = 10;
const GENERIC_LABELS = ["Current location", "Custom location", "Pinned location"];
const pointKey = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
const NOTE_KEY = "sw_rider_note";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The rider can only see a map pin; informal addresses (a gate, a landmark) are what actually gets them to the door.
async function sendAddressToHub(orderId, line, landmark) {
  if (!line && !landmark) return;
  for (let i = 0; i < 3; i++) {
    try { await api.saveDeliveryAddress(orderId, { line, landmark }); return; } catch { await sleep(2500); }
  }
}

export default function CartDrawer({ open, onClose, onOrderPlaced, onTrackOrder }) {
  const { cart, medicinesById, rxImage, addToCart, removeFromCart, clearCart } = useCart();
  const { location, setLocation, detectLocation, detecting } = useLocation();
  const { customer } = useAuth();
  const { openLogin } = useAuthUI();
  const { online } = useNetwork();
  const { activeOrder, refresh: refreshActiveOrder, markPlaced } = useActiveOrder();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [pinnedKey, setPinnedKey] = useState(null);
  const [note, setNote] = useState(() => { try { return localStorage.getItem(NOTE_KEY) || ""; } catch { return ""; } });

  const isAuthenticated = !!customer;

  // All hooks stay above the early return.
  useBackHandler(open, onClose);

  // Contextual GPS prompt: ask when the user actually needs a location (opening the cart), not at app launch.
  useEffect(() => {
    if (open && !location && !detecting) detectLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = useMemo(
    () => Object.entries(cart).map(([id, qty]) => ({ medicine: medicinesById[id], qty })).filter((i) => i.medicine),
    [cart, medicinesById]
  );
  const itemTotal = useMemo(() => items.reduce((s, i) => s + (Number(i.medicine.price) || 0) * i.qty, 0), [items]);
  const rxItems = useMemo(() => items.filter((i) => isRx(i.medicine)).map((i) => i.medicine), [items]);

  if (!open) return null;

  const toPay = itemTotal + DELIVERY_FEE + HANDLING_FEE;
  const requiresRx = rxItems.length > 0;
  const canPlaceOrder = !requiresRx || !!rxImage;
  const hasLocation = !!location && Number.isFinite(location.lat) && Number.isFinite(location.lng);
  const pinConfirmed = hasLocation && pinnedKey === pointKey(location);

  let ctaLabel = `Place Order · ${formatINR(toPay)}`;
  if (!isAuthenticated) ctaLabel = "Log in to Place Order";
  else if (activeOrder) ctaLabel = "Order in progress";
  else if (submitting) ctaLabel = "Placing Order…";
  else if (!online) ctaLabel = "You're offline";
  else if (!canPlaceOrder) ctaLabel = "Upload Prescription to Proceed";
  else if (!hasLocation) ctaLabel = "Set delivery location to proceed";
  else if (!pinConfirmed) ctaLabel = `Confirm Location & Place Order · ${formatINR(toPay)}`;

  const submitOrder = async (override) => {
    const target = override || location;
    const targetOk = !!target && Number.isFinite(target.lat) && Number.isFinite(target.lng);
    if (submitting) return;
    if (!isAuthenticated) { onClose(); openLogin(); return; }
    if (activeOrder) { setError(ONGOING_ORDER_MESSAGE); return; }

    const lines = items.map((i) => ({ name: i.medicine.name, quantity: i.qty }));
    if (lines.length === 0) { setError("Add at least one item to your cart."); return; }
    if (!online) { setError("You're offline. Reconnect to place your order."); return; }
    if (!targetOk) { setError("Set your delivery location before ordering."); return; }
    if (requiresRx && !rxImage) { setError("Upload a photo of your prescription before ordering."); return; }

    setSubmitting(true);
    setError("");
    try {
      // Identity comes from the JWT (Authorization header). The Hub must derive customer id/phone from it.
      const result = await api.createOrder({
        lat: target.lat,
        lng: target.lng,
        pinned: !!override || pinConfirmed,   // the customer placed the pin on their doorstep: the rider navigates to exactly these coordinates
        radiusKm: ORDER_RADIUS_KM,
        items: lines,
        rxImage,
        requiresRx,
      });
      if (result.status === "UNFULFILLABLE") {
        hapticError();
        setError(result.message || "No nearby pharmacy has your full order in stock.");
        return;
      }
      hapticSuccess();
      const named = target.label && !GENERIC_LABELS.includes(target.label) ? target.label : "";
      markPlaced(result.orderId);
      refreshActiveOrder();
      sendAddressToHub(result.orderId, named, note.trim());   // fire and forget: never delays or blocks the order
      try { localStorage.setItem(NOTE_KEY, note.trim()); } catch { /* ignore */ }
      clearCart();
      onOrderPlaced(result.orderId);
    } catch (e) {
      hapticError();
      if (e.code === "ACTIVE_ORDER") refreshActiveOrder();   // another phone (or a stale screen) already has one in progress
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCta = () => {
    const ready = isAuthenticated && !activeOrder && !submitting && online && canPlaceOrder && hasLocation;
    if (ready && !pinConfirmed) { setPinOpen(true); return; }
    submitOrder();
  };
  const confirmPin = (point) => {
    const keep = location && location.label && !GENERIC_LABELS.includes(location.label) ? location.label : "Pinned location";   // keep a saved address's name
    const pinned = { lat: point.lat, lng: point.lng, label: keep };
    setLocation(pinned);
    setPinnedKey(pointKey(pinned));
    setPinOpen(false);
    submitOrder(pinned);
  };

  return (
    <>
      <div className="sw-back" onClick={onClose} />
      <aside className="sw-drawer" role="dialog" aria-modal="true">
        <div className="sw-d-head">
          <span>My Cart</span>
          <button className="sw-x" onClick={onClose} aria-label="Close cart">✕</button>
        </div>

        <div className="sw-d-body">
          {activeOrder && (
            <div className="swp-blocked" role="alert">
              <b>Your order is on its way 🛵</b>
              <p>{describeActiveOrder(activeOrder)}.</p>
              <p>{ONGOING_ORDER_MESSAGE}</p>
              <button className="sw-cta" onClick={() => { onClose(); onTrackOrder?.(activeOrder.id); }}>Track your order</button>
            </div>
          )}

          {items.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>Your cart is empty.</div>}

          {items.length > 0 && (
            <>
              <div className="sw-box">
                {items.map(({ medicine, qty }) => (
                  <div key={medicine.id} className="sw-line">
                    <div className="swp-thumb swp-thumb--cart"><MedicineThumbnail medicine={medicine} size={46} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: ".86rem" }}>{medicine.name}</div>
                      <div className="sw-mini">{captionFor(medicine)} · {formatINR(medicine.price)}</div>
                      {isRx(medicine) && <div className="sw-rxpill" style={{ marginTop: 4 }}>Rx Required</div>}
                    </div>
                    <QtyStepper qty={qty} onAdd={() => addToCart(medicine)} onRemove={() => removeFromCart(medicine)} />
                  </div>
                ))}
              </div>

              {requiresRx && <PrescriptionUpload rxItems={rxItems} />}

              <div className="sw-box">
                <div style={{ fontWeight: 800, fontSize: ".86rem", marginBottom: 6 }}>Delivering to</div>
                <AddressSelector variant="inline" />
                <input className="sw-input" style={{ marginTop: 8 }} maxLength={140} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Flat no. / landmark for the rider (optional)" aria-label="Note for the delivery rider" />
              </div>

              <div className="sw-box">
                <div style={{ fontWeight: 800, fontSize: ".86rem", marginBottom: 6 }}>Bill details</div>
                <div className="sw-bill"><span>Item total</span><span>{formatINR(itemTotal)}</span></div>
                <div className="sw-bill"><span>Delivery fee</span>{DELIVERY_FEE > 0 ? <span>{formatINR(DELIVERY_FEE)}</span> : <span className="sw-free">FREE</span>}</div>
                <div className="sw-bill"><span>Handling fee</span>{HANDLING_FEE > 0 ? <span>{formatINR(HANDLING_FEE)}</span> : <span className="sw-free">FREE</span>}</div>
                <div className="sw-bill total"><span>To Pay</span><span>{formatINR(toPay)}</span></div>
              </div>

              <ErrorBanner message={error} />
            </>
          )}
        </div>

        {items.length > 0 && (
          <div className="sw-d-foot">
            <button className="sw-cta" onClick={handleCta}
              disabled={isAuthenticated && (!!activeOrder || submitting || !online || !canPlaceOrder || !hasLocation)}>
              {ctaLabel}
            </button>
          </div>
        )}
      </aside>
      {pinOpen && <PinpointSheet initial={location} onClose={() => setPinOpen(false)} onConfirm={confirmPin} />}
    </>
  );
}

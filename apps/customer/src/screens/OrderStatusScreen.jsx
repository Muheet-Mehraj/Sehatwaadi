import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { ErrorBanner } from '../components/common/UIComponents';
import { useLocation } from '../context/LocationContext';
import { useActiveOrder } from '../context/ActiveOrderContext';
import { lockMode, ONGOING_ORDER_MESSAGE } from '../config/app';
import '../assets/product-detail.css';
import { hapticSuccess } from '../utils/native';

const STYLES = `
.swt-code { background:#fff; border:2px solid var(--green,#0C831F); border-radius:16px; padding:18px; margin-top:14px; }
.swt-code h3 { font-size:.95rem; margin-bottom:10px; }
.swt-digits { display:flex; gap:10px; justify-content:center; margin:6px 0 10px; }
.swt-digit { width:52px; height:62px; border-radius:12px; background:var(--green-bg,#F7FFF9); border:1.5px solid var(--green,#0C831F); font-size:2rem; font-weight:800; display:flex; align-items:center; justify-content:center; color:var(--green-dark,#0A6B19); }
.swt-note { font-size:.78rem; color:var(--muted,#6B6B6B); }
.swt-rider { display:flex; align-items:center; gap:12px; background:#fff; border:1px solid var(--line,#E8E8E8); border-radius:14px; padding:14px; margin-top:14px; text-align:left; }
.swt-avatar { width:44px; height:44px; border-radius:50%; background:var(--green-bg,#F7FFF9); display:grid; place-items:center; font-size:1.4rem; flex:none; }
.swt-big { font-size:1.15rem; font-weight:800; }
.swt-cancel { margin-top:12px; color:#B42318; font-weight:700; font-size:.85rem; text-decoration:underline; }
.swt-confirm { margin-top:12px; background:#FEF3F2; border-radius:12px; padding:12px; }
.swt-confirm p { font-weight:700; margin-bottom:8px; }
.swt-confirm div { display:flex; gap:8px; justify-content:center; }
.swt-confirm button { padding:9px 16px; border-radius:10px; font-weight:700; background:#fff; border:1px solid var(--line,#E8E8E8); }
.swt-confirm button.danger { background:#B42318; color:#fff; border-color:#B42318; }
`;

const SUCCESS_ORDER = new Set(['DELIVERED', 'COMPLETED']);
const FAILED_ORDER = new Set(['UNFULFILLABLE', 'CANCELLED', 'REJECTED']);
const RIDER_ASSIGNED = new Set(['ACCEPTED', 'ARRIVED_AT_PHARMACY', 'PICKED_UP', 'DELIVERED']);
const VEHICLE = { SCOOTER: 'scooter', MOTORCYCLE: 'motorcycle', BICYCLE: 'bicycle' };

const km = (a, b) => {
  const R = 6371, r = (x) => (x * Math.PI) / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtKm = (v) => (v < 1 ? `${Math.max(50, Math.round(v * 1000 / 50) * 50)} m` : `${v.toFixed(1)} km`);
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return Number.isNaN(s) ? '' : s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`;
};

export default function OrderStatusScreen({ orderId, onNewOrder }) {
  const { location } = useLocation();
  const [order, setOrder] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [otp, setOtp] = useState(null);
  const [error, setError] = useState('');
  const { activeOrder, refresh: refreshActiveOrder } = useActiveOrder();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const otpRef = useRef(null);
  const buzzed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const tick = async () => {
      let next = 8000;
      if (!document.hidden) {
        try {
          const o = await api.getOrder(orderId);
          if (cancelled) return;
          setOrder(o); setError('');
          if (['MATCHING', 'SENT_TO_PHARMACY'].includes(o.status)) next = 2000;
          else if (FAILED_ORDER.has(o.status)) next = 0;

          // Once a pharmacy has accepted, follow the delivery. A failure here never hides the order itself.
          if (!['MATCHING', 'SENT_TO_PHARMACY'].includes(o.status) && !FAILED_ORDER.has(o.status)) {
            try {
              const r = await api.getDelivery(orderId);
              if (cancelled) return;
              const d = r.delivery || null;
              setDelivery(d);
              if (d && d.status === 'PICKED_UP' && !otpRef.current) {
                api.getDeliveryOtp(orderId).then((x) => { if (!cancelled && x.otp) { otpRef.current = x.otp; setOtp(x.otp); } }).catch(() => {});
              }
              if (d && (d.status === 'DELIVERED' || d.status === 'CANCELLED' || d.status === 'RETURNED')) { otpRef.current = null; setOtp(null); next = 0; }
            } catch { /* keep polling; transient */ }
            if (SUCCESS_ORDER.has(o.status)) next = 0;
          }
        } catch (e) {
          if (cancelled) return;
          setError(e.message); next = 4000;
        }
      }
      if (!cancelled && next > 0) timer = setTimeout(tick, next);
    };

    tick();
    const onVis = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };   // refresh the moment the app comes back to the foreground
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [orderId]);

  const ds = delivery?.status;
  const delivered = ds === 'DELIVERED' || SUCCESS_ORDER.has(order?.status);
  const failed = FAILED_ORDER.has(order?.status) || ds === 'CANCELLED' || cancelled;
  const returning = ds === 'RETURNING_TO_PHARMACY' || ds === 'RETURNED';
  const accepted = !!order && !['MATCHING', 'SENT_TO_PHARMACY'].includes(order.status) && !failed;
  const rider = delivery?.rider || null;

  // The moment the order is over, release the one-order-at-a-time lock.
  useEffect(() => { if (delivered || failed || returning) refreshActiveOrder(); }, [delivered, failed, returning, refreshActiveOrder]);

  const lockedHere = lockMode() === 'full' && !!activeOrder && !delivered && !failed && !returning;
  const canCancel = accepted && !delivered && !failed && !returning && order?.status === 'ACCEPTED'
    && (!ds || ['DISPATCHED', 'ACCEPTED', 'ARRIVED_AT_PHARMACY'].includes(ds));
  const doCancel = async () => {
    setCancelling(true); setCancelError('');
    try { await api.cancelOrder(orderId); setCancelled(true); refreshActiveOrder(); }
    catch (e) { setCancelError(e.message); }
    finally { setCancelling(false); setConfirmCancel(false); }
  };

  useEffect(() => { if (delivered && !buzzed.current) { buzzed.current = true; hapticSuccess(); } }, [delivered]);

  const steps = [
    { label: 'Order placed', done: true },
    { label: 'Pharmacy confirmed', done: accepted },
    { label: rider ? `${rider.firstName} is on the way to the pharmacy` : 'Rider assigned', done: RIDER_ASSIGNED.has(ds) },
    { label: 'Rider at the pharmacy', done: ['ARRIVED_AT_PHARMACY', 'PICKED_UP', 'DELIVERED'].includes(ds) },
    { label: 'Out for delivery', done: ['PICKED_UP', 'DELIVERED'].includes(ds) || order?.status === 'OUT_FOR_DELIVERY' },
    { label: 'Delivered', done: delivered },
  ];
  const current = steps.findIndex((s) => !s.done);

  let headline = 'Processing…';
  if (order?.status === 'MATCHING') headline = 'Finding a nearby pharmacy…';
  else if (order?.status === 'SENT_TO_PHARMACY') headline = 'Waiting for the pharmacy to confirm…';
  else if (delivered) headline = 'Delivered ✓';
  else if (cancelled || order?.status === 'CANCELLED') headline = 'Order cancelled';
  else if (returning) headline = "We couldn't complete your delivery";
  else if (failed && ds === 'CANCELLED') headline = 'Delivery cancelled';
  else if (accepted && (!delivery || ds === 'DISPATCHED')) headline = 'Finding a delivery rider…';
  else if (ds === 'ACCEPTED') headline = 'Your rider is heading to the pharmacy';
  else if (ds === 'ARRIVED_AT_PHARMACY') headline = 'Your rider is collecting your order';
  else if (ds === 'PICKED_UP') headline = 'Your order is on the way';

  const live = ds === 'PICKED_UP' && rider && rider.lat != null && rider.lng != null;
  const away = live && location && Number.isFinite(location.lat) ? km(rider, location) : null;

  return (
    <div className="sw-status">
      <style>{STYLES}</style>
      <h2>Order Status</h2>
      <ErrorBanner message={error} />
      {lockedHere && <div className="pd-locked" role="alert">{ONGOING_ORDER_MESSAGE}</div>}

      {order?.status === 'UNFULFILLABLE' ? (
        <p style={{ color: '#DC2626', fontWeight: 'bold', marginTop: 16 }}>Sorry, we couldn't find a pharmacy to fulfill your order right now.</p>
      ) : (
        <>
          <p className="swt-big" style={{ color: returning || failed ? '#B42318' : 'var(--green)', margin: '14px 0 0' }}>{headline}</p>
          {returning && <p className="swt-note" style={{ marginTop: 6 }}>Your medicines are going back to the pharmacy. They will contact you, or you can reorder.</p>}

          {rider && ['ACCEPTED', 'ARRIVED_AT_PHARMACY', 'PICKED_UP'].includes(ds) && (
            <div className="swt-rider">
              <div className="swt-avatar">🛵</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{rider.firstName}</div>
                <div className="swt-note">
                  Your delivery partner{rider.vehicleType && VEHICLE[rider.vehicleType] ? ` · ${VEHICLE[rider.vehicleType]}` : ''}
                  {away != null ? ` · about ${fmtKm(away)} away` : ''}
                  {live && rider.updatedAt ? ` · updated ${ago(rider.updatedAt)}` : ''}
                </div>
              </div>
              {live && <a className="swt-note" style={{ color: 'var(--green)', fontWeight: 700 }} target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${rider.lat},${rider.lng}`}>Map</a>}
            </div>
          )}

          {otp && ds === 'PICKED_UP' && (
            <div className="swt-code" role="region" aria-label="Delivery code">
              <h3>Your delivery code</h3>
              <div className="swt-digits">{otp.split('').map((d, i) => <span key={i} className="swt-digit">{d}</span>)}</div>
              <div className="swt-note">Tell this code to the rider <b>only when you have your medicines in hand</b>. Never share it by phone or message.</div>
            </div>
          )}
          {!otp && accepted && !delivered && !returning && !failed && ds !== 'PICKED_UP' && (
            <p className="swt-note" style={{ marginTop: 10 }}>Your 4-digit delivery code will appear here once the rider picks up your order.</p>
          )}

          {canCancel && !confirmCancel && <button className="swt-cancel" onClick={() => setConfirmCancel(true)}>Cancel order</button>}
          {canCancel && confirmCancel && (
            <div className="swt-confirm" role="alertdialog" aria-label="Confirm cancel">
              <p>Cancel this order?</p>
              <div><button onClick={() => setConfirmCancel(false)}>Keep order</button><button className="danger" disabled={cancelling} onClick={doCancel}>Yes, cancel</button></div>
            </div>
          )}
          <ErrorBanner message={cancelError} />

          <div className="sw-timeline">
            {steps.map((s, i) => (
              <div key={s.label} className="sw-tl">
                <span className="sw-dot" style={{ background: s.done ? 'var(--green)' : i === current ? 'var(--yellow)' : '#D9D9D9' }} />
                <span style={{ fontWeight: s.done || i === current ? 700 : 500, color: s.done || i === current ? 'var(--ink)' : 'var(--muted)' }}>{s.label}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!lockedHere && !delivered && !failed && !returning && <p className="swt-note" style={{ marginTop: 14 }}>You can place a new order once this one is delivered.</p>}
      {!lockedHere && (
        <button onClick={onNewOrder} style={{ marginTop: 18, padding: '12px 24px', background: '#0C831F', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 'bold', cursor: 'pointer' }}>
        {delivered || failed || returning ? 'Order again' : 'Back to home'}
      </button>
      )}
    </div>
  );
}

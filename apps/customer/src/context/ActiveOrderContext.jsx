import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

// One order at a time (like a ride): while this holds an order, checkout is closed until it is delivered, cancelled or has failed.
// The Hub enforces the same rule, so a second phone or a stale screen can't get around it.
const POLL_MS = 15000;
const STAGE_TEXT = { PICKED_UP: 'Out for delivery', ARRIVED_AT_PHARMACY: 'Your rider is collecting your order', ACCEPTED: 'Your rider is heading to the pharmacy', DISPATCHED: 'Finding a delivery rider' };
const ORDER_TEXT = { MATCHING: 'Finding a pharmacy', SENT_TO_PHARMACY: 'Waiting for the pharmacy', ACCEPTED: 'Order confirmed', OUT_FOR_DELIVERY: 'Out for delivery' };

export const describeActiveOrder = (order) => (order && (STAGE_TEXT[order.deliveryStatus] || ORDER_TEXT[order.status])) || 'Order in progress';

const ActiveOrderContext = createContext({ activeOrder: null, refresh: async () => null, markPlaced: () => {} });

export function ActiveOrderProvider({ children }) {
  const { customer } = useAuth();
  const [activeOrder, setActiveOrder] = useState(null);

  const refresh = useCallback(async () => {
    if (!customer) { setActiveOrder(null); return null; }
    try {
      const { order } = await api.getActiveOrder();
      setActiveOrder(order || null);
      return order || null;
    } catch {
      return undefined;   // offline or the Hub is waking up: keep what we last knew
    }
  }, [customer]);

  // Right after placing an order, lock immediately instead of waiting for the next check.
  const markPlaced = useCallback((orderId) => setActiveOrder({ id: orderId, status: 'MATCHING', deliveryStatus: null }), []);

  useEffect(() => { refresh(); }, [refresh]);

  const hasActive = !!activeOrder;
  useEffect(() => {
    if (!customer) return undefined;
    const check = () => { if (!document.hidden) refresh(); };
    const timer = hasActive ? setInterval(check, POLL_MS) : null;   // only poll while something is in progress
    document.addEventListener('visibilitychange', check);
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [customer, hasActive, refresh]);

  const value = useMemo(() => ({ activeOrder, refresh, markPlaced }), [activeOrder, refresh, markPlaced]);
  return <ActiveOrderContext.Provider value={value}>{children}</ActiveOrderContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActiveOrder() {
  return useContext(ActiveOrderContext);
}

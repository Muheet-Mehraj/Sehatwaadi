import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { NetworkProvider } from "./context/NetworkContext.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { AuthUIProvider } from "./context/AuthUIContext.jsx";
import { ActiveOrderProvider, useActiveOrder } from "./context/ActiveOrderContext.jsx";
import { NavContext } from "./context/NavContext.jsx";
import { lockMode } from "./config/app.js";
import { CartProvider } from "./context/CartContext.jsx";
import { LocationProvider } from "./context/LocationContext.jsx";
import HomeScreen from "./screens/HomeScreen.jsx";
import OrderStatusScreen from "./screens/OrderStatusScreen.jsx";
import OrderHistoryScreen from "./screens/OrderHistoryScreen.jsx";
import ProductDetailScreen from "./screens/ProductDetailScreen.jsx";
import CartDrawer from "./components/cart/CartDrawer.jsx";
import { OfflineBanner } from "./components/common/UIComponents.jsx";
import { useBackHandler } from "./hooks/useBackHandler.js";
import { initBackButton } from "./utils/backStack.js";
import "./assets/global.css";

// Opening/closing the drawer re-renders Shell; memo keeps the product grid out of that.
const Home = memo(HomeScreen);

function Shell() {
  const [screen, setScreen] = useState("home"); // "home" | "status" | "orders" | "product"
  const [activeProductId, setActiveProductId] = useState(null);
  const { activeOrder } = useActiveOrder();
  // One order at a time. In "full" mode the customer is held on the tracking screen until it is delivered, cancelled or fails.
  const locked = lockMode() === "full" && !!activeOrder;
  const [activeOrderId, setActiveOrderId] = useState(null);
  const [statusFrom, setStatusFrom] = useState("home"); // where Back from "status" should go
  const [cartOpen, setCartOpen] = useState(false);

  useEffect(() => { initBackButton(); }, []);

  const openCart = useCallback(() => setCartOpen(true), []);
  const closeCart = useCallback(() => setCartOpen(false), []);
  const openOrders = useCallback(() => setScreen("orders"), []);
  const goHome = useCallback(() => setScreen("home"), []);

  const openProduct = useCallback((id) => { setActiveProductId(id); setScreen("product"); }, []);

  useEffect(() => {
    if (!locked) return;
    setActiveOrderId(activeOrder.id);
    setScreen("status");
    setCartOpen(false);
  }, [locked, activeOrder]);

  const handleOrderPlaced = useCallback((orderId) => {
    setActiveOrderId(orderId);
    setStatusFrom("home");
    setCartOpen(false);
    setScreen("status");
  }, []);

  const handleOpenPastOrder = useCallback((orderId) => {
    setActiveOrderId(orderId);
    setStatusFrom("orders");
    setScreen("status");
  }, []);

  const handleTrackOrder = useCallback((orderId) => {
    setActiveOrderId(orderId);
    setStatusFrom("home");
    setScreen("status");
  }, []);

  const handleNewOrder = useCallback(() => {
    setActiveOrderId(null);
    setScreen("home");
  }, []);

  // Back from tracking goes where the user came from (history or home). The order stays in My Orders.
  const statusBack = statusFrom === "orders" ? openOrders : goHome;

  // Android back: orders -> home; tracking -> where you came from.
  const screenNow = locked ? "status" : screen;
  const orderIdNow = locked ? activeOrder.id : activeOrderId;
  const swallowBack = useCallback(() => {}, []);
  useBackHandler(locked, swallowBack);                         // no way out of the tracking screen with the back button
  useBackHandler(screenNow === "orders", goHome);
  useBackHandler(screenNow === "product", goHome);
  useBackHandler(screenNow === "status" && !locked, statusBack);

  let body;
  if (screenNow === "status" && orderIdNow) {
    body = <OrderStatusScreen orderId={orderIdNow} onNewOrder={handleNewOrder} onBack={statusBack} />;
  } else if (screenNow === "product" && activeProductId) {
    body = <ProductDetailScreen medicineId={activeProductId} onBack={goHome} />;
  } else if (screenNow === "orders") {
    body = <OrderHistoryScreen onBack={goHome} onOpenOrder={handleOpenPastOrder} />;
  } else {
    body = <Home onOpenCart={openCart} onOpenOrders={openOrders} onTrackOrder={handleTrackOrder} />;
  }

  const nav = useMemo(() => ({ openProduct, openCart, openOrders, goHome, goBack: goHome }), [openProduct, openCart, openOrders, goHome]);

  return (
    <NavContext.Provider value={nav}>
      <OfflineBanner />
      {body}
      <CartDrawer open={cartOpen && !locked} onClose={closeCart} onOrderPlaced={handleOrderPlaced} onTrackOrder={handleTrackOrder} />
    </NavContext.Provider>
  );
}

export default function App() {
  return (
    <NetworkProvider>
      <AuthProvider>
        <AuthUIProvider>
          <ActiveOrderProvider>
            <LocationProvider>
              <CartProvider>
                <Shell />
              </CartProvider>
            </LocationProvider>
          </ActiveOrderProvider>
        </AuthUIProvider>
      </AuthProvider>
    </NetworkProvider>
  );
}


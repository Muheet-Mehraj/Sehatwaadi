import { createContext, useContext } from 'react';

// Screen navigation, available anywhere without passing callbacks down: product cards open a product, the product screen opens the cart.
const noop = () => {};
export const NavContext = createContext({ openProduct: noop, openCart: noop, openOrders: noop, goHome: noop, goBack: noop });

// eslint-disable-next-line react-refresh/only-export-components
export const useNav = () => useContext(NavContext);

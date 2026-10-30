import React from 'react';
import { useCart, useCartActions } from '../../context/CartContext';
import { QtyStepper } from '../common/UIComponents';
import { toCartItem } from '../../utils/product';

/** ADD, which becomes the quantity stepper after the first tap. Reads and writes the cart directly. */
export default function AddControl({ item }) {
  const { cart } = useCart();
  const { addToCart, removeFromCart } = useCartActions();
  return <QtyStepper qty={cart[item.id] || 0} onAdd={() => addToCart(toCartItem(item))} onRemove={() => removeFromCart(toCartItem(item))} />;
}

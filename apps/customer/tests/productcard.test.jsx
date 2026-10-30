import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CartProvider, useCart } from "./context/CartContext.jsx";
import ProductCard from "./components/common/ProductCard.jsx";

let reads = 0;
const A = { id: "a", get name() { reads++; return "ALPHA TAB"; }, price: 50, mrp: 80, schedule_class: "OTC" };
const B = { id: "b", name: "BETA SYRUP", price: 120, schedule_class: "H" };

function Harness() {
  const { cart } = useCart();
  return <>{[A, B].map((m) => <ProductCard key={m.id} medicine={m} qty={cart[m.id] || 0} />)}</>;
}

describe("ProductCard", () => {
  it("shows price, MRP and the discount; swaps ADD for a stepper on first tap; caps at 10", async () => {
    render(<CartProvider><Harness /></CartProvider>);
    expect(screen.getByText("₹50")).toBeTruthy(); expect(screen.getByText("₹80")).toBeTruthy(); expect(screen.getByText("38% OFF")).toBeTruthy();
    expect(screen.getByText("Rx Required")).toBeTruthy(); expect(screen.getAllByText("ADD").length).toBe(2);
    await act(async () => { fireEvent.click(screen.getAllByText("ADD")[0]); });
    expect(screen.getAllByText("ADD").length).toBe(1); expect(screen.getByLabelText("Remove one")).toBeTruthy(); expect(screen.getByText("1")).toBeTruthy();
    for (let i = 0; i < 12; i++) await act(async () => { fireEvent.click(screen.getByLabelText("Add one")); });
    expect(screen.getByText("10")).toBeTruthy(); expect(screen.getByLabelText("Add one").disabled).toBe(true);
    for (let i = 0; i < 10; i++) await act(async () => { fireEvent.click(screen.getByLabelText("Remove one")); });
    expect(screen.getAllByText("ADD").length).toBe(2);
  });

  it("is memoized: adding a DIFFERENT medicine does not re-render this card", async () => {
    render(<CartProvider><Harness /></CartProvider>);
    const before = reads;
    await act(async () => { fireEvent.click(screen.getAllByText("ADD")[1]); });       // add BETA
    expect(screen.getByText("1")).toBeTruthy(); expect(reads).toBe(before);           // ALPHA untouched
    await act(async () => { fireEvent.click(screen.getAllByText("ADD")[0]); });       // add ALPHA itself
    expect(reads).toBeGreaterThan(before);
  });
});

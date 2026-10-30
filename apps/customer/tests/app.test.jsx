import React from "react";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import L from "leaflet";
import App from "./App.jsx";
import PromoBanner from "./components/product/PromoBanner.jsx";
import { resetHomeCache } from "./screens/HomeScreen.jsx";

vi.mock("leaflet", () => {
  const maps = [];
  const L = { __maps: maps, tileLayer: () => ({ addTo() {} }),
    map: () => { const h = {}; const m = { center: { lat: 34.0805, lng: 74.7905 }, setView(ll) { m.center = { lat: ll[0], lng: ll[1] }; return m; }, on(ev, cb) { h[ev] = cb; return m; }, getCenter: () => m.center, invalidateSize() {}, remove() {}, __fire(ev) { if (h[ev]) h[ev](); } }; maps.push(m); return m; } };
  return { default: L, ...L };
});

const med = (id, name, price, sched = "OTC", image_url = null) => ({ id, name, price, schedule_class: sched, image_url });
const CROCIN = med("m1", "CROCIN ADVANCE TAB", 20, "OTC", "https://img.example/crocin.jpg");
const DOLO = med("m2", "DOLO 650MG TAB", 30.5);
const AUG = med("m3", "AUGMENTIN 625 TAB", 300, "H");
const DULCO = med("m5", "DULCOFLEX TABLET 15", 14.87);
const CATS = [
  { key: "pain-fever", name: "Pain & Fever", icon: "🌡️", color: "#FFE9E3", items: [CROCIN, DOLO, AUG] },
  { key: "cold-cough", name: "Cold & Cough", icon: "🤧", color: "#E7F1FF", items: [] },
  { key: "herbal", name: "Kashmiri Herbal", icon: "🏔️", color: "#EFF7E4", items: [med("m4", "HIMALAYA LIVER CARE", 140)] },
];
const salt = [{ salt: "Bisacodyl", strength: "5 mg" }];
const base = { scheduleClass: "OTC", unitLabel: "Units", highlights: [], ingredients: [], keyUses: [], howToUse: [], safety: [], storage: null, regulatoryStatus: null, contentSource: null, images: [] };
const DULCO_DETAIL = { ok: true, medicine: { ...base, id: "m5", name: "DULCOFLEX TABLET 15", price: 14.87, mrp: 18.59, discountPercent: 20, manufacturer: "Opella Healthcare India Private Limited", unitCount: 15, pricePerUnit: 0.99, composition: salt, storage: "Store below 30 °C",
    images: [{ url: "https://img.example/a.jpg", caption: "Front" }, { url: "https://img.example/b.jpg", caption: "Back" }, { url: "https://img.example/c.jpg", caption: "Strip" }],
    highlights: ["Relieves occasional constipation"], ingredients: ["Bisacodyl IP 5 mg"], keyUses: ["Constipation"], howToUse: ["Swallow whole with water"], safety: ["Not for children under 4 years"], contentSource: "Pharmacy listings, 2026-10-20" },
  substitute: { ...base, id: "m6", name: "BOLAX TABLET 10", price: 6.24, mrp: null, discountPercent: 0, manufacturer: "Cipla Ltd.", unitCount: 10, pricePerUnit: 0.62, composition: salt, matchPercent: 100, savingsPercent: 37, verification: { sourceUrl: "https://example.org/proof", verifiedOn: "2026-10-20", verifiedBy: "test" } },
  related: [{ id: "m7", name: "CREMAFFIN FRESH", price: 120, schedule_class: "OTC", image_url: null, hasSubstitute: true }], relatedTitle: "More in Digestive Care" };
const BOLAX_DETAIL = { ok: true, medicine: { ...base, ...DULCO_DETAIL.substitute, discountPercent: 0 }, substitute: null, related: [], relatedTitle: null };
const DOLO_DETAIL = { ok: true, medicine: { ...base, id: "m2", name: "DOLO 650MG TAB", price: 30.5, mrp: null, discountPercent: 0, manufacturer: null, unitCount: null, pricePerUnit: null, composition: [] }, substitute: null, related: [], relatedTitle: null };
const RIDER = { firstName: "Asha", vehicleType: "SCOOTER", lat: null, lng: null, updatedAt: null };
const ACTIVE = { id: "abcdef12-0000-0000-0000-000000000000", status: "ACCEPTED", deliveryStatus: "ACCEPTED" };
const NEW_ORDER_ID = "11111111-2222-3333-4444-555555555555";

class IO { constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = new Set(); IO.all.push(this); } observe(el) { this.els.add(el); } unobserve() {} disconnect() { this.els.clear(); }
  fire(map) { act(() => this.cb([...this.els].map((el) => ({ target: el, isIntersecting: !!map[el.dataset.spyKey] })))); } }
IO.all = []; const liveIO = () => IO.all.filter((o) => o.els.size).at(-1);
let S, calls, scrolled;
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const route = (url, opts = {}) => {
  const path = url.replace("http://localhost:8080", ""); const method = (opts.method || "GET").toUpperCase(); calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
  if (path === "/api/catalog/home") return S.catalogDown ? json({ error: "x" }, 404) : json({ ok: true, essentials: [DOLO, DULCO], categories: CATS });
  if (path.startsWith("/api/catalog/medicine/")) { const d = S.details[path.split("/").pop()]; return S.detailDown ? json({ error: "x" }, 500) : d ? json(d) : json({ error: "medicine_not_found" }, 404); }
  if (path.startsWith("/api/catalog/category/")) return json({ ok: true, items: CATS.find((c) => path.endsWith(c.key))?.items || [] });
  if (path.startsWith("/api/medicines/search")) return json([DOLO]);
  if (path.endsWith("/send-otp")) return json({ ok: true });
  if (path.endsWith("/verify-otp")) return json({ token: "jwt-abc", customer: { id: "c1", name: "Aaliya", phone: "9906000001" } });
  if (path === "/api/orders/create") {
    if (S.create409) { S.active = { id: "99999999-0000-0000-0000-000000000000", status: "ACCEPTED", deliveryStatus: "ACCEPTED" }; return json({ ok: false, code: "ACTIVE_ORDER", error: "You have an ongoing order. Please wait for it to be completed before placing a new one." }, 409); }
    S.active = { id: NEW_ORDER_ID, status: "MATCHING", deliveryStatus: null }; return json({ status: "MATCHING", orderId: NEW_ORDER_ID });
  }
  if (path === "/api/delivery/my-active-order") return json({ ok: true, order: S.active });
  if (path.endsWith("/cancel")) { if (S.cancelResult) return json(S.cancelResult.body, S.cancelResult.status); S.orderStatus = "CANCELLED"; S.delivery = { status: "CANCELLED", rider: null }; S.active = null; return json({ ok: true }); }
  if (/^\/api\/orders\/[^/]+$/.test(path)) return json({ status: S.orderStatus });
  if (path.endsWith("/address")) return S.addressFails-- > 0 ? json({ error: "boom" }, 500) : json({ ok: true });
  if (path.endsWith("/otp")) return json({ ok: true, otp: "4821" });
  if (path.startsWith("/api/delivery/by-order/")) return json({ ok: true, delivery: S.delivery });
  return json({ error: "nope" }, 404);
};
const flush = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { try { return fn(); } catch { await flush(150); } } return fn(); };
const click = async (el) => act(async () => { fireEvent.click(el); });
const login = () => { localStorage.setItem("sw_token", "jwt-abc"); localStorage.setItem("sw_customer", JSON.stringify({ id: "c1", name: "Aaliya", phone: "9906000001" })); };
const openFirstProductCart = async () => { await until(() => screen.getAllByText("ADD")); await click(screen.getAllByText("ADD")[0]); await click(screen.getByText(/View cart/)); await flush(100); };
const movePin = (lat, lng) => { const map = L.__maps.at(-1); map.center = { lat, lng }; act(() => { map.__fire("movestart"); map.__fire("moveend"); }); };

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); window.scrollTo = () => {}; IO.all = []; scrolled = []; L.__maps.length = 0; resetHomeCache();
  vi.stubGlobal("IntersectionObserver", IO); vi.stubGlobal("requestAnimationFrame", (cb) => { cb(); return 1; }); Element.prototype.scrollIntoView = function () { scrolled.push(this.dataset.spyKey); };
  S = { catalogDown: false, detailDown: false, orderStatus: "MATCHING", delivery: null, addressFails: 0, active: null, create409: false, cancelResult: null, details: { m5: DULCO_DETAIL, m6: BOLAX_DETAIL, m2: DOLO_DETAIL } }; calls = [];
  vi.stubGlobal("fetch", vi.fn((u, o) => route(u, o)));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("home (dual pane)", () => {
  it("renders the rail, banners, quick filters, sections, photos and Made in Kashmir", async () => {
    render(<App />); await flush(50); await until(() => screen.getByText(/Pain & Fever/, { selector: ".swd-sec-title" }));
    const rail = screen.getByRole("navigation", { name: "Categories" });
    expect(within(rail).getByRole("button", { name: /Essentials/ })).toBeTruthy(); expect(within(rail).getByRole("button", { name: /Kashmiri Herbal/ })).toBeTruthy(); expect(within(rail).queryByRole("button", { name: /Cold & Cough/ })).toBeNull();
    expect(document.querySelector(".swd-body > .swd-side")).toBeTruthy(); expect(screen.getByText("Medicines at your door")).toBeTruthy();
    expect(screen.getAllByText("DOLO 650MG TAB").length).toBe(1);
    expect(screen.getAllByRole("img", { name: "CROCIN ADVANCE TAB" }).find((e) => e.tagName === "IMG").getAttribute("src")).toBe("https://img.example/crocin.jpg");
    expect(screen.getByText("MADE IN KASHMIR")).toBeTruthy(); expect(calls.find((c) => c.path === "/api/catalog/home").auth).toBeUndefined();
  });
  it("scroll-spy highlights the category in view; tapping the rail scrolls and ignores the observer mid-scroll", async () => {
    render(<App />); await flush(50); await until(() => screen.getByText(/Kashmiri Herbal/, { selector: ".swd-sec-title" }));
    const rail = screen.getByRole("navigation", { name: "Categories" }); const btn = (re) => within(rail).getByRole("button", { name: re });
    expect(btn(/Essentials/).getAttribute("aria-current")).toBe("true"); expect(liveIO().opts.rootMargin).toBe("-80px 0px -65% 0px");
    liveIO().fire({ "pain-fever": true }); expect(btn(/Pain & Fever/).getAttribute("aria-current")).toBe("true");
    await click(btn(/Kashmiri Herbal/)); expect(scrolled).toEqual(["herbal"]); liveIO().fire({ "pain-fever": true }); expect(btn(/Kashmiri Herbal/).getAttribute("aria-current")).toBe("true");
    await flush(900); liveIO().fire({ "pain-fever": true }); expect(btn(/Pain & Fever/).getAttribute("aria-current")).toBe("true");
  });
  it("quick filters narrow every section", async () => {
    render(<App />); await flush(50); await until(() => screen.getByText("AUGMENTIN 625 TAB"));
    await click(screen.getByRole("button", { name: "Rx medicines" })); expect(screen.getByText("AUGMENTIN 625 TAB")).toBeTruthy(); expect(screen.queryByText("CROCIN ADVANCE TAB")).toBeNull();
    await click(screen.getByRole("button", { name: "All" })); await click(screen.getByRole("button", { name: "Under ₹100" })); expect(screen.queryByText("AUGMENTIN 625 TAB")).toBeNull();
  });
  it("search, failed search with Retry, catalog down fallback, slow first load", async () => {
    render(<App />); await flush(50); await until(() => screen.getAllByText("ADD"));
    await act(async () => { fireEvent.change(screen.getByLabelText("Search medicines"), { target: { value: "dolo" } }); }); await flush(400); expect(await until(() => screen.getByText(/Results for/))).toBeTruthy();
    let fail = true; const real = fetch.getMockImplementation(); vi.stubGlobal("fetch", vi.fn((u, o) => (fail && String(u).includes("/api/medicines/search") ? Promise.reject(new TypeError("Failed to fetch")) : real(u, o))));
    await act(async () => { fireEvent.change(screen.getByLabelText("Search medicines"), { target: { value: "thermometer" } }); }); await flush(400);
    expect(await until(() => screen.getByText(/Couldn't search right now/))).toBeTruthy(); expect(screen.queryByText(/No medicines found/)).toBeNull();
    fail = false; await click(screen.getByText("Retry")); await flush(400); expect(await until(() => screen.getByText("DOLO 650MG TAB"))).toBeTruthy();
  });
  it("keeps the rail usable when the catalog is unreachable, and explains a slow first load", async () => {
    S.catalogDown = true; render(<App />); await flush(50); expect(await until(() => screen.getByText(/Couldn't load the catalog/))).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Categories" })).getAllByRole("button").length).toBe(10);
  });
  it("shows the slow-load hint while the Hub wakes up", async () => {
    vi.stubGlobal("fetch", vi.fn((u) => (String(u).includes("/api/catalog/home") ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, json: async () => ({}) }))));
    render(<App />); await flush(50); expect(screen.queryByText(/first load can take a moment/)).toBeNull(); await flush(6200); expect(screen.getByText(/first load can take a moment/)).toBeTruthy();
  });
});

describe("product detail page", () => {
  const openDulco = async () => { render(<App />); await flush(50); await click(await until(() => screen.getByRole("button", { name: "View DULCOFLEX TABLET 15" }))); await flush(100); await until(() => screen.getByRole("heading", { name: "DULCOFLEX TABLET 15" })); };

  it("opens from a product card: sticky bar, multi-photo carousel with dots, product info, composition, storage", async () => {
    await openDulco();
    expect(screen.getByText("Item details")).toBeTruthy(); expect(screen.getByLabelText("Back")).toBeTruthy(); expect(screen.getByLabelText("Search")).toBeTruthy(); expect(screen.getByLabelText(/^Cart/)).toBeTruthy();
    expect(document.querySelector(".pd-promo")).toBeNull();                                         // no promo unless one is configured
    expect(document.querySelectorAll(".pd-slide img").length).toBe(3); const dots = screen.getAllByRole("tab"); expect(dots.length).toBe(3); expect(dots[0].getAttribute("aria-selected")).toBe("true");
    const track = document.querySelector(".pd-track"); Object.defineProperty(track, "clientWidth", { value: 300, configurable: true }); track.scrollLeft = 300; act(() => { fireEvent.scroll(track); });
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");              // swipe moves the pagination dot
    expect(screen.getAllByText("Opella Healthcare India Private Limited").length).toBe(2); expect(screen.getByText("Strip of 15 Units")).toBeTruthy();
    expect(screen.getByText("MRP ₹18.59")).toBeTruthy(); expect(screen.getByText("20% OFF")).toBeTruthy(); expect(screen.getAllByText("₹14.87").length).toBeGreaterThan(0); expect(screen.getByText("₹0.99/Units")).toBeTruthy();
    expect(screen.getAllByText("Bisacodyl (5 Mg)").length).toBeGreaterThan(0); expect(screen.getByText(/Store below 30/)).toBeTruthy();
  });
  it("shows the purple substitute banner, the verified substitute card and the side-by-side comparison with the 100% match badge", async () => {
    await openDulco();
    expect(screen.getByText("💊 37% Lower Price Substitute")).toBeTruthy(); expect(screen.getByText("CIPLA LTD.")).toBeTruthy(); expect(screen.getByText(/EXACT SAME COMPOSITION/)).toBeTruthy();
    const subCard = document.querySelector(".pd-sub-card"); expect(within(subCard).getByText("BOLAX TABLET 10")).toBeTruthy(); expect(within(subCard).getByText("₹6.24")).toBeTruthy(); expect(within(subCard).getByText("Strip of 10 Units")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Compare your medicine" })).toBeTruthy();
    const grid = document.querySelector(".pd-cgrid"); const kids = [...grid.children];
    expect(kids.map((k) => k.className.split(" ")[0])).toEqual(["pd-ccard", "pd-match", "pd-ccard"]);   // the badge sits between the two cards
    expect(within(grid).getByRole("img", { name: "100% match" })).toBeTruthy(); expect(within(kids[2]).getByText("Substitute")).toBeTruthy(); expect(kids[2].className).toContain("pd-ccard--sub");
    expect(within(kids[0]).getByText("₹0.99/unit")).toBeTruthy(); expect(within(kids[2]).getByText("₹0.62/unit")).toBeTruthy(); expect(within(kids[2]).getByText("37% cheaper")).toBeTruthy();
    expect(within(kids[0]).getByText("Bisacodyl (5 Mg)")).toBeTruthy(); expect(within(kids[2]).getByText("Bisacodyl (5 Mg)")).toBeTruthy();
    expect(within(kids[0]).queryByText(/FDA|approved|licensed/i)).toBeNull();                       // no regulatory claim unless the data has one
  });
  it("ADD swaps to the stepper for the medicine and for the substitute independently; the header cart badge follows", async () => {
    await openDulco();
    const row = document.querySelector(".pd-addrow"); await click(within(row).getByText("ADD")); expect(within(row).getByLabelText("Remove one")).toBeTruthy(); expect(screen.getByLabelText("Cart, 1 item")).toBeTruthy();
    const subCard = document.querySelector(".pd-sub-card"); await click(within(subCard).getByText("ADD")); expect(within(subCard).getByLabelText("Remove one")).toBeTruthy(); expect(screen.getByLabelText("Cart, 2 items")).toBeTruthy();
    expect(within(row).getByText("1")).toBeTruthy();
  });
  it("tapping the substitute opens its details in a bottom sheet", async () => {
    await openDulco(); await click(screen.getByRole("button", { name: "View BOLAX TABLET 10" })); await flush(100);
    const sheet = await until(() => screen.getByRole("dialog", { name: "Item details" })); expect(await until(() => within(sheet).getByRole("heading", { name: "BOLAX TABLET 10" }))).toBeTruthy(); expect(within(sheet).getByText("Cipla Ltd.")).toBeTruthy();
    await click(within(sheet).getByLabelText("Close")); expect(screen.queryByRole("dialog", { name: "Item details" })).toBeNull();
  });
  it("without a verified substitute there is no banner and no comparison", async () => {
    render(<App />); await flush(50); await click(await until(() => screen.getByRole("button", { name: "View DOLO 650MG TAB" }))); await flush(100);
    await until(() => screen.getByRole("heading", { name: "DOLO 650MG TAB" })); expect(screen.queryByText(/Lower Price Substitute/)).toBeNull(); expect(screen.queryByText("Compare your medicine")).toBeNull(); expect(screen.getByText("Composition not listed yet")).toBeTruthy();
  });
  it("accordions open one at a time; empty sections say so", async () => {
    await openDulco();
    expect(screen.queryByText("Constipation")).toBeNull();
    await click(screen.getByRole("button", { name: /Key uses/ })); expect(screen.getByText("Constipation")).toBeTruthy();
    await click(screen.getByRole("button", { name: /How to use/ })); expect(screen.queryByText("Constipation")).toBeNull(); expect(screen.getByText("Swallow whole with water")).toBeTruthy();
    await click(screen.getByRole("button", { name: /Safety information/ })); expect(screen.getByText("Not for children under 4 years")).toBeTruthy(); expect(screen.getByRole("button", { name: /Safety information/ }).getAttribute("aria-expanded")).toBe("true");
  });
  it("shows 'More in <category>' with a Substitute-available tag, a compact header on scroll, and Back returns home", async () => {
    await openDulco();
    expect(screen.getByRole("heading", { name: "More in Digestive Care" })).toBeTruthy(); expect(screen.getByText("Substitute available")).toBeTruthy(); expect(screen.getByText("CREMAFFIN FRESH")).toBeTruthy();
    const obs = IO.all.find((o) => [...o.els].some((e) => e.classList.contains("pd-addrow"))); const row = [...obs.els][0];
    act(() => obs.cb([{ target: row, isIntersecting: false, boundingClientRect: { top: -80 } }]));
    const bar = document.querySelector(".pd-bar"); expect(within(bar).getByText("DULCOFLEX TABLET 15")).toBeTruthy(); expect(within(bar).getByText(/₹14.87 · 20% off/)).toBeTruthy(); expect(within(bar).getByText("ADD")).toBeTruthy(); expect(within(bar).queryByText("Item details")).toBeNull();
    act(() => obs.cb([{ target: row, isIntersecting: true, boundingClientRect: { top: 200 } }])); expect(within(bar).getByText("Item details")).toBeTruthy();
    await click(screen.getByLabelText("Back")); expect(await until(() => screen.getByText("MADE IN KASHMIR"))).toBeTruthy(); expect(screen.queryByText("Item details")).toBeNull();
  });
  it("a failed load says so and Retry works; the promo strip appears only when text is configured", async () => {
    S.detailDown = true; render(<App />); await flush(50); await click(await until(() => screen.getByRole("button", { name: "View DULCOFLEX TABLET 15" }))); await flush(100);
    expect(await until(() => screen.getByText(/Couldn't load this medicine/))).toBeTruthy(); S.detailDown = false; await click(screen.getByText("Retry")); await flush(100);
    expect(await until(() => screen.getByRole("heading", { name: "DULCOFLEX TABLET 15" }))).toBeTruthy();
    const { container } = render(<PromoBanner text="FLAT 25% off on first order" />); expect(container.textContent).toContain("FLAT 25% off on first order"); expect(render(<PromoBanner text="" />).container.textContent).toBe("");
  });
});

describe("one order at a time: full lock (default)", () => {
  it("an order in progress holds the customer on the tracking screen with the exact alert; no way to browse or order", async () => {
    login(); S.active = ACTIVE; S.orderStatus = "ACCEPTED"; S.delivery = { status: "ACCEPTED", rider: RIDER };
    render(<App />); await flush(100);
    expect(await until(() => screen.getByText("Order Status"))).toBeTruthy(); expect(screen.getByRole("alert", { name: "" }).textContent).toBe("You have an ongoing order. Please wait for it to be completed before placing a new one.");
    expect(screen.queryByLabelText("Search medicines")).toBeNull(); expect(screen.queryByText("Back to home")).toBeNull(); expect(screen.queryByText("Place New Order")).toBeNull(); expect(screen.queryByText(/View cart/)).toBeNull();
  });
  it("the lock lifts when the order is delivered: the summary stays, and 'Order again' returns to the shop", async () => {
    login(); S.active = ACTIVE; S.orderStatus = "ACCEPTED"; S.delivery = { status: "ACCEPTED", rider: RIDER };
    render(<App />); await flush(100); await until(() => screen.getByText("Order Status"));
    S.orderStatus = "DELIVERED"; S.delivery = { status: "DELIVERED", rider: RIDER }; S.active = null; await flush(8200);
    expect(await until(() => screen.getByText("Delivered ✓"))).toBeTruthy(); expect(screen.queryByText(/ongoing order/)).toBeNull();
    await click(screen.getByText("Order again")); expect(await until(() => screen.getByLabelText("Search medicines"))).toBeTruthy();
  });
  it("another phone / stale screen: the Hub refuses with 409 and the app locks onto the order", async () => {
    login(); S.create409 = true; render(<App />); await flush(100); await openFirstProductCart();
    await click(await until(() => screen.getByRole("button", { name: /Place Order/ }))); await flush(200);
    movePin(34.091234, 74.812345); await click(await until(() => screen.getByText("Confirm location"))); await flush(300);
    expect(await until(() => screen.getByText("Order Status"))).toBeTruthy(); expect(screen.getByText(/You have an ongoing order/)).toBeTruthy();
  });
  it("no Cancel once the rider has the medicines; a late cancel is explained and changes nothing", async () => {
    login(); S.active = ACTIVE; S.orderStatus = "OUT_FOR_DELIVERY"; S.delivery = { status: "PICKED_UP", rider: RIDER };
    const first = render(<App />); await flush(100); expect(await until(() => screen.getByText("Your order is on the way"))).toBeTruthy(); expect(screen.queryByText("Cancel order")).toBeNull(); first.unmount();
    S.orderStatus = "ACCEPTED"; S.delivery = { status: "ACCEPTED", rider: RIDER }; S.cancelResult = { status: 409, body: { ok: false, code: "TOO_LATE", error: "Your rider has already picked up your order, so it can't be cancelled." } };
    render(<App />); await flush(100); await click(await until(() => screen.getByText("Cancel order"))); await click(screen.getByText("Yes, cancel")); await flush(100);
    expect(await until(() => screen.getByText(/already picked up your order/))).toBeTruthy(); expect(screen.queryByText("Order cancelled")).toBeNull(); expect(screen.getByText(/You have an ongoing order/)).toBeTruthy();
  });
});

describe("one order at a time: checkout-only lock (VITE_ORDER_LOCK_MODE=checkout)", () => {
  beforeEach(() => { vi.stubEnv("VITE_ORDER_LOCK_MODE", "checkout"); });
  it("the customer can browse, but the checkout button is disabled, nothing is sent, and it unlocks by itself", async () => {
    login(); S.active = ACTIVE; S.delivery = { status: "ACCEPTED", rider: null }; S.orderStatus = "ACCEPTED";
    render(<App />); await flush(100); expect(await until(() => screen.getByLabelText("Search medicines"))).toBeTruthy(); await openFirstProductCart();
    const cta = await until(() => screen.getByRole("button", { name: "Order in progress" })); expect(cta.disabled).toBe(true);
    expect(within(screen.getByRole("alert")).getByText("You have an ongoing order. Please wait for it to be completed before placing a new one.")).toBeTruthy();
    await click(cta); expect(calls.some((c) => c.path === "/api/orders/create")).toBe(false);
    S.active = null; await flush(15500); expect((await until(() => screen.getByRole("button", { name: /Place Order/ }))).disabled).toBe(false);
  });
  it("shows a Track strip on the home screen and 'Track your order' in the cart opens the tracking screen", async () => {
    login(); S.active = ACTIVE; S.delivery = { status: "ACCEPTED", rider: null }; S.orderStatus = "ACCEPTED";
    render(<App />); await flush(100); await openFirstProductCart();
    await click(await until(() => screen.getByRole("button", { name: "Track your order" }))); await flush(100); expect(await until(() => screen.getByText("Order Status"))).toBeTruthy();
  });
});

describe("checkout: map pin, order placement and tracking", () => {
  it("full journey: log in, drop the pin on the doorstep, place the order with the exact coordinates, address note reaches the Hub, track the rider, get the code, delivered", async () => {
    S.addressFails = 1; render(<App />); await flush(50); await openFirstProductCart();
    await click(await until(() => screen.getByRole("button", { name: /Log in to Place Order/ })));
    await act(async () => { fireEvent.change(await until(() => screen.getByPlaceholderText("10-digit mobile number")), { target: { value: "9906000001" } }); }); await click(screen.getByText("Send OTP")); await flush(50);
    await act(async () => { fireEvent.change(await until(() => screen.getByPlaceholderText("••••••")), { target: { value: "123456" } }); }); await click(screen.getByText("Verify & Continue")); await flush(100);
    await click(screen.getByText(/View cart/)); await flush(100);
    await act(async () => { fireEvent.change(await until(() => screen.getByLabelText("Note for the delivery rider")), { target: { value: "Green gate near the chinar" } }); });

    const place = await until(() => screen.getByRole("button", { name: /Confirm Location & Place Order/ })); expect(place.disabled).toBe(false);
    await click(place); await flush(100);
    const pin = await until(() => screen.getByRole("dialog", { name: "Confirm delivery location" })); expect(within(pin).getByText(/Move the map to place the pin/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/orders/create")).toBe(false);                          // nothing is sent until the pin is confirmed
    await click(within(pin).getByLabelText("Close map")); expect(screen.queryByRole("dialog", { name: "Confirm delivery location" })).toBeNull(); expect(calls.some((c) => c.path === "/api/orders/create")).toBe(false);
    await click(screen.getByRole("button", { name: /Confirm Location & Place Order/ })); await flush(100);
    movePin(34.091234, 74.812345); expect(screen.getByText(/^Pin: 34\.0912\d, 74\.8123\d$/)).toBeTruthy();
    await click(screen.getByText("Confirm location")); await flush(300);

    const create = calls.find((c) => c.path === "/api/orders/create");
    expect(create.auth).toBe("Bearer jwt-abc"); expect(create.body.lat).toBe(34.091234); expect(create.body.lng).toBe(74.812345); expect(create.body.pinned).toBe(true); expect(create.body.items).toEqual([{ name: "DOLO 650MG TAB", quantity: 1 }]);
    await flush(6000); const addr = calls.filter((c) => c.path.endsWith("/address")); expect(addr.length).toBe(2); expect(addr[1].body.landmark).toBe("Green gate near the chinar");
    expect(await until(() => screen.getByText("Order Status"))).toBeTruthy(); expect(screen.getByText(/You have an ongoing order/)).toBeTruthy();   // locked the moment it is placed
    expect(screen.getByText("Finding a nearby pharmacy…")).toBeTruthy();
    S.orderStatus = "ACCEPTED"; S.delivery = { status: "ACCEPTED", rider: RIDER }; await flush(2200); expect(await until(() => screen.getByText("Your rider is heading to the pharmacy"))).toBeTruthy();
    S.orderStatus = "OUT_FOR_DELIVERY"; S.delivery = { status: "PICKED_UP", rider: { ...RIDER, lat: 34.085, lng: 74.795, updatedAt: new Date().toISOString() } }; await flush(8200);
    expect((await until(() => screen.getByRole("region", { name: "Delivery code" }))).textContent).toContain("4821");
    S.orderStatus = "DELIVERED"; S.delivery = { status: "DELIVERED", rider: RIDER }; S.active = null; await flush(8200);
    expect(await until(() => screen.getByText("Delivered ✓"))).toBeTruthy(); expect(screen.queryByRole("region", { name: "Delivery code" })).toBeNull(); expect(screen.getByText("Order again")).toBeTruthy();
  });
  it("after the pin is confirmed once for a location, the same location is not asked again; right after placing, the customer can still cancel before pickup", async () => {
    login(); S.orderStatus = "ACCEPTED"; S.delivery = { status: "ACCEPTED", rider: RIDER };
    render(<App />); await flush(100); await openFirstProductCart();
    await click(await until(() => screen.getByRole("button", { name: /Confirm Location & Place Order/ }))); await flush(100); movePin(34.09, 74.8); await click(screen.getByText("Confirm location")); await flush(300);
    expect(await until(() => screen.getByText("Order Status"))).toBeTruthy(); await flush(2200);
    await click(await until(() => screen.getByText("Cancel order"))); expect(screen.getByRole("alertdialog", { name: "Confirm cancel" })).toBeTruthy(); await click(screen.getByText("Yes, cancel")); await flush(100);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel"))).toBe(true); expect(await until(() => screen.getByText("Order cancelled"))).toBeTruthy(); expect(screen.queryByText(/ongoing order/)).toBeNull();
    await click(screen.getByText("Order again")); await openFirstProductCart();
    expect((await until(() => screen.getByRole("button", { name: /Place Order/ }))).textContent).toMatch(/^Place Order/);   // pin already confirmed for this spot
  });
});

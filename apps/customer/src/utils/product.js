// Small pure helpers for the product screens.
export const toCartItem = (m) => ({ id: m.id, name: m.name, price: m.price, mrp: m.mrp || undefined, schedule_class: m.scheduleClass || undefined, image_url: m.images && m.images[0] ? m.images[0].url : undefined });

// 37 -> "37", 49.9 -> "49.9" (the Hub truncates to one decimal, never rounds up)
export const formatPercent = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));

// "5 mg" -> "5 Mg", as pharmacy apps print strengths
export const formatStrength = (s) => String(s || '').replace(/\b(mg|mcg|g|ml|iu)\b/i, (u) => u[0].toUpperCase() + u.slice(1).toLowerCase());
export const formatSalt = (c) => `${c.salt} (${formatStrength(c.strength)})`;

// The rider app only accepts this exact shape: SW1.<delivery_id>.<token>.
export const QR_RE = /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{16,64}$/i;

// The Hub's get_pickup_qr / get_return_qr answers in one of a few shapes; accept any that yields a valid code.
export function extractQr(res, deliveryId) {
  if (!res) return null;
  const direct = [res.qr, res.qr_payload, res.payload, res.code, res.data && res.data.qr].find((v) => typeof v === "string" && QR_RE.test(v));
  if (direct) return direct;
  const token = res.pickup_token || res.return_token || res.token;
  if (typeof token === "string" && deliveryId) {
    const built = `SW1.${deliveryId}.${token}`;
    if (QR_RE.test(built)) return built;
  }
  return null;
}

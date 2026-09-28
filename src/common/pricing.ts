/** Money is integer IDR. Mirrors the storefront's lib/pricing.ts so totals match on both sides. */
export const FREE_DELIVERY = 500_000;
export const STANDARD_DELIVERY = 25_000;
export const EXPRESS_DELIVERY = 50_000;

export type PricedLine = {
  qty: number;
  unitPrice: number;
  voucherEligible: boolean;
};

export type Promo = {
  code: string;
  type: 'percent' | 'fixed' | 'free_delivery';
  value: number;
  minSpend: number;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
};

export const lineTotal = (l: PricedLine) => l.qty * l.unitPrice;
export const subtotalOf = (lines: PricedLine[]) =>
  lines.reduce((n, l) => n + lineTotal(l), 0);
const eligibleOf = (lines: PricedLine[]) =>
  subtotalOf(lines.filter((l) => l.voucherEligible));

/** Why a promo cannot be used on these lines, or null when it can (BAG-5 messages). */
export function checkPromo(
  promo: Promo | null,
  lines: PricedLine[],
  now = new Date(),
): string | null {
  if (!promo || !promo.active) return "This code isn't valid.";
  if (
    (promo.startsAt && now < promo.startsAt) ||
    (promo.endsAt && now > promo.endsAt)
  )
    return 'This code has expired.';
  if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit)
    return 'This code has been fully redeemed.';
  const subtotal = subtotalOf(lines);
  if (subtotal < promo.minSpend)
    return `Spend IDR ${promo.minSpend.toLocaleString('en-US')} to use this code.`;
  if (promo.type !== 'free_delivery' && eligibleOf(lines) === 0)
    return "This code can't be used on items excluded from vouchers.";
  return null;
}

/** Discount on goods. Only voucher-eligible lines count; never more than they cost. */
export function promoDiscount(promo: Promo | null, lines: PricedLine[]) {
  if (!promo) return 0;
  const eligible = eligibleOf(lines);
  if (promo.type === 'percent')
    return Math.round((eligible * promo.value) / 100);
  if (promo.type === 'fixed') return Math.min(promo.value, eligible);
  return 0;
}

export function deliveryFee(
  subtotal: number,
  method: 'standard' | 'express',
  promo: Promo | null,
) {
  if (subtotal === 0 || promo?.type === 'free_delivery') return 0;
  if (method === 'express') return EXPRESS_DELIVERY;
  return subtotal >= FREE_DELIVERY ? 0 : STANDARD_DELIVERY;
}

/** Full quote. Pass only a promo that already passed checkPromo. */
export function quote(
  lines: PricedLine[],
  method: 'standard' | 'express' = 'standard',
  promo: Promo | null = null,
) {
  const subtotal = subtotalOf(lines);
  const discount = promoDiscount(promo, lines);
  const delivery = deliveryFee(subtotal, method, promo);
  return {
    subtotal,
    discount,
    delivery,
    total: subtotal - discount + delivery,
    freeDeliveryRemaining: Math.max(0, FREE_DELIVERY - subtotal),
    /** Fee for each method, so checkout can show both before the shopper picks */
    deliveryOptions: {
      standard: deliveryFee(subtotal, 'standard', promo),
      express: deliveryFee(subtotal, 'express', promo),
    },
  };
}

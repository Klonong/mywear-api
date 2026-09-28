import {
  checkPromo,
  deliveryFee,
  promoDiscount,
  quote,
  type Promo,
} from './pricing';

const promo = (p: Partial<Promo> = {}): Promo => ({
  code: 'FIELD10',
  type: 'percent',
  value: 10,
  minSpend: 0,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  usedCount: 0,
  active: true,
  ...p,
});

const tee = { qty: 2, unitPrice: 249_000, voucherEligible: true };
const excluded = { qty: 1, unitPrice: 1_090_000, voucherEligible: false };

describe('pricing', () => {
  it('charges delivery below the free threshold, express always, nothing for an empty bag', () => {
    expect(deliveryFee(0, 'standard', null)).toBe(0);
    expect(deliveryFee(499_999, 'standard', null)).toBe(25_000);
    expect(deliveryFee(500_000, 'standard', null)).toBe(0);
    expect(deliveryFee(900_000, 'express', null)).toBe(50_000);
    expect(
      deliveryFee(100_000, 'express', promo({ type: 'free_delivery' })),
    ).toBe(0);
  });

  it('discounts only voucher-eligible lines', () => {
    expect(promoDiscount(promo(), [tee, excluded])).toBe(49_800);
    expect(
      promoDiscount(promo({ type: 'fixed', value: 1_000_000 }), [
        tee,
        excluded,
      ]),
    ).toBe(498_000);
    expect(promoDiscount(null, [tee])).toBe(0);
  });

  it('rejects codes that cannot apply', () => {
    const now = new Date('2026-09-28');
    expect(checkPromo(promo(), [tee], now)).toBeNull();
    expect(checkPromo(null, [tee], now)).toMatch(/isn't valid/);
    expect(checkPromo(promo({ active: false }), [tee], now)).toMatch(
      /isn't valid/,
    );
    expect(
      checkPromo(promo({ endsAt: new Date('2026-01-01') }), [tee], now),
    ).toMatch(/expired/);
    expect(
      checkPromo(promo({ usageLimit: 5, usedCount: 5 }), [tee], now),
    ).toMatch(/fully redeemed/);
    expect(checkPromo(promo({ minSpend: 600_000 }), [tee], now)).toMatch(
      /Spend IDR 600,000/,
    );
    expect(checkPromo(promo(), [excluded], now)).toMatch(
      /excluded from vouchers/,
    );
    expect(
      checkPromo(promo({ type: 'free_delivery' }), [excluded], now),
    ).toBeNull();
  });

  it('builds a full quote', () => {
    expect(quote([tee, excluded], 'standard', promo())).toEqual({
      subtotal: 1_588_000,
      discount: 49_800,
      delivery: 0,
      total: 1_538_200,
      freeDeliveryRemaining: 0,
      deliveryOptions: { standard: 0, express: 50_000 },
    });
    expect(quote([tee]).total).toBe(498_000 + 25_000);
  });
});

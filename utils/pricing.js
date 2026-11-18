const PLAN_TIERS = Object.freeze(
  [
    { tier: 1, dailyLimit: 1000, monthlyPriceUsd: 10 },
    { tier: 2, dailyLimit: 2000, monthlyPriceUsd: 18 },
    { tier: 3, dailyLimit: 3000, monthlyPriceUsd: 25 },
    { tier: 4, dailyLimit: 4000, monthlyPriceUsd: 32 },
    { tier: 5, dailyLimit: 5000, monthlyPriceUsd: 40 },
    { tier: 6, dailyLimit: 6000, monthlyPriceUsd: 48 },
    { tier: 7, dailyLimit: 7000, monthlyPriceUsd: 55 },
    { tier: 8, dailyLimit: 8000, monthlyPriceUsd: 62 },
    { tier: 9, dailyLimit: 9000, monthlyPriceUsd: 70 },
    { tier: 10, dailyLimit: 10000, monthlyPriceUsd: 75 },
  ].map((plan) =>
    Object.freeze({
      ...plan,
      batchLimit: plan.dailyLimit / 10,
    }),
  ),
);

const PLAN_DURATIONS_MONTHS = Object.freeze([1, 3, 6, 12]);
const TERM_DISCOUNTS = Object.freeze({
  1: 0,
  3: 5,
  6: 10,
  12: 15,
});
const PLAN_TERMS = Object.freeze(
  PLAN_DURATIONS_MONTHS.map((months) =>
    Object.freeze({ months, discountPercent: TERM_DISCOUNTS[months] }),
  ),
);
const plansByDailyLimit = new Map(
  PLAN_TIERS.map((plan) => [plan.dailyLimit, plan]),
);

function getPlanTier(dailyLimit) {
  const parsed = Number(dailyLimit);
  return Number.isSafeInteger(parsed) ? plansByDailyLimit.get(parsed) || null : null;
}

function getPlanPricing(dailyLimit, durationMonths) {
  const plan = getPlanTier(dailyLimit);
  const months = Number(durationMonths);
  if (!plan || !PLAN_DURATIONS_MONTHS.includes(months)) return null;
  const basePriceCents = plan.monthlyPriceUsd * months * 100;
  const discountPercent = TERM_DISCOUNTS[months];
  const discountCents = Math.round(basePriceCents * discountPercent / 100);
  return Object.freeze({
    plan,
    durationMonths: months,
    basePriceCents,
    discountPercent,
    discountCents,
    totalCents: basePriceCents - discountCents,
  });
}

function getPlanTotalCents(dailyLimit, durationMonths) {
  const pricing = getPlanPricing(dailyLimit, durationMonths);
  return pricing ? pricing.totalCents : null;
}

module.exports = {
  PLAN_TIERS,
  PLAN_DURATIONS_MONTHS,
  PLAN_TERMS,
  getPlanTier,
  getPlanPricing,
  getPlanTotalCents,
};

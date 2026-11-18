const { PLAN_TIERS, PLAN_DURATIONS_MONTHS, PLAN_TERMS } = require('../utils/pricing');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  return res.status(200).json({
    plans: PLAN_TIERS,
    durationsMonths: PLAN_DURATIONS_MONTHS,
    terms: PLAN_TERMS,
    currency: 'USD',
    onlineCheckoutComingSoon: true,
  });
};

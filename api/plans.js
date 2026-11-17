const { PLAN_TIERS, PLAN_DURATIONS_MONTHS } = require('../utils/pricing');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  return res.status(200).json({
    plans: PLAN_TIERS,
    durationsMonths: PLAN_DURATIONS_MONTHS,
    currency: 'USD',
    onlineCheckoutComingSoon: true,
  });
};

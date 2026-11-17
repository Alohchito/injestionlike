module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'GET');
  return res.status(410).json({
    error: 'Payment agent details are private and are sent directly by the billing team.',
  });
};

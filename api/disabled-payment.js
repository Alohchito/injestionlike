module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  return res.status(410).json({
    error: 'Online payment endpoints are disabled. Submit a manual-payment order instead.',
  });
};

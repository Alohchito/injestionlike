const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function parseTrustedEnvelopeFrom(envelopeFrom) {
  if (typeof envelopeFrom !== 'string' || /[\r\n]/.test(envelopeFrom)) {
    throw new TypeError('A trusted SMTP envelope-from address is required.');
  }
  const normalized = envelopeFrom.trim().toLowerCase();
  if (!emailPattern.test(normalized)) {
    throw new TypeError('The SMTP envelope-from address is invalid.');
  }
  return normalized;
}

async function createAuthenticatedForward({
  rawMessage,
  envelopeFrom,
  authenticationResults,
  arcSigner,
}) {
  if (!Buffer.isBuffer(rawMessage) || rawMessage.length === 0) {
    throw new TypeError('The original raw message is required.');
  }
  if (
    typeof authenticationResults !== 'string' ||
    !authenticationResults.trim() ||
    /[\r\n]/.test(authenticationResults)
  ) {
    throw new TypeError('Trusted upstream authentication results are required.');
  }
  if (typeof arcSigner !== 'function') {
    throw new Error('An aligned ARC signing adapter is not configured.');
  }

  return arcSigner({
    rawMessage,
    envelopeFrom: parseTrustedEnvelopeFrom(envelopeFrom),
    authenticationResults: authenticationResults.trim(),
  });
}

module.exports = { createAuthenticatedForward, parseTrustedEnvelopeFrom };

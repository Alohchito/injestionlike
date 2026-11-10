function parseRequestBody(body, contentType = '') {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }

  if (typeof body !== 'string' || body.length === 0) {
    return {};
  }

  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    const parsedBody = JSON.parse(body);
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      throw new TypeError('Request body must be a JSON object.');
    }
    return parsedBody;
  }

  if (mediaType === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(body));
  }

  throw new TypeError('Unsupported request content type.');
}

module.exports = { parseRequestBody };
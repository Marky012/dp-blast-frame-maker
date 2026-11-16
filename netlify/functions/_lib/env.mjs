export function getEnv(key, defaultValue = undefined) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const val = Netlify.env.get(key);
      if (val !== undefined && val !== '') return val;
    }
  } catch {
    // Fallback to process.env below
  }
  if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined && process.env[key] !== '') {
    return process.env[key];
  }
  return defaultValue;
}

export function getClientIp(req, context) {
  const nfIp = req.headers.get('x-nf-client-connection-ip')?.split(',')[0].trim();
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0].trim();

  const isLoopback =
    !nfIp || nfIp === '127.0.0.1' || nfIp === '::1' || nfIp === '::ffff:127.0.0.1';

  if (nfIp && !isLoopback) {
    return nfIp;
  }
  if (forwarded) {
    return forwarded;
  }
  if (nfIp) {
    return nfIp;
  }
  if (context && context.ip) return context.ip;
  return '127.0.0.1';
}

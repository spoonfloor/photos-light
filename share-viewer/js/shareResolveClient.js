/**
 * Share-resolve HTTP client — structured errors, retry policy, single read gate.
 */
const ShareResolveClient = (() => {
  const PERMANENT_CODES = new Set([
    'share_not_found',
    'share_revoked',
    'share_expired',
    'share_misconfigured',
  ]);

  const RETRYABLE_CODES = new Set(['share_unavailable']);
  const RETRYABLE_HTTP = new Set([502, 503, 504, 429]);
  const DEFAULT_ATTEMPTS = 3;

  const MESSAGES = {
    share_not_found:
      'This link is no longer valid and the requested photos are unavailable.',
    share_revoked:
      'This link is no longer valid and the requested photos are unavailable.',
    share_expired:
      'This link is no longer valid and the requested photos are unavailable.',
    share_unavailable:
      "Couldn't reach the share service. Check your connection and try again.",
    share_misconfigured: 'Share service is misconfigured. Try again later.',
    missing_token: 'Missing share link.',
    cancelled: 'Loading cancelled.',
    generic: 'Could not load share.',
  };

  class ShareResolveError extends Error {
    constructor(message, { code = null, status = null, retryable = false } = {}) {
      super(message);
      this.name = 'ShareResolveError';
      this.code = code;
      this.status = status;
      this.retryable = retryable;
    }
  }

  function shareResolveUrl(config) {
    if (config.shareResolveUrl) {
      return config.shareResolveUrl;
    }
    return `${config.supabaseUrl}/functions/v1/share-resolve`;
  }

  function authHeaders(config) {
    return {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    };
  }

  function isTransientNetworkError(error) {
    if (!error || error.name === 'AbortError') {
      return false;
    }
    const message = String(error.message || '').toLowerCase();
    return message === 'network error' || message.includes('failed to fetch');
  }

  function parseJsonBody(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  function inferCode(status, body) {
    if (body?.code) {
      return body.code;
    }
    if (status === 404) {
      return 'share_not_found';
    }
    if (status === 410) {
      return 'share_revoked';
    }
    if (RETRYABLE_HTTP.has(status) || status >= 500) {
      return 'share_unavailable';
    }
    return null;
  }

  function isRetryable(status, code) {
    if (code && PERMANENT_CODES.has(code)) {
      return false;
    }
    if (code && RETRYABLE_CODES.has(code)) {
      return true;
    }
    if (RETRYABLE_HTTP.has(status)) {
      return true;
    }
    if (status >= 500 && code !== 'share_misconfigured') {
      return true;
    }
    return false;
  }

  function isPermanentFailure(code) {
    return PERMANENT_CODES.has(code);
  }

  function messageForCode(code, fallback) {
    if (code && MESSAGES[code]) {
      return MESSAGES[code];
    }
    return fallback || MESSAGES.generic;
  }

  function buildUrl(token, searchParams = {}) {
    const config = window.SHARE_VIEWER_CONFIG;
    const params = new URLSearchParams(searchParams);
    params.set('token', token);
    return `${shareResolveUrl(config)}?${params.toString()}`;
  }

  async function fetchOnce(url, { signal } = {}) {
    const config = window.SHARE_VIEWER_CONFIG;
    const response = await fetch(url, {
      headers: authHeaders(config),
      signal,
    });
    const body = parseJsonBody(await response.text());
    if (response.ok) {
      return body;
    }

    const code = inferCode(response.status, body);
    const retryable = isRetryable(response.status, code);
    const message = messageForCode(
      code,
      body.error || `Could not load share (${response.status})`,
    );
    throw new ShareResolveError(message, {
      code,
      status: response.status,
      retryable,
    });
  }

  async function fetchWithRetry(url, { signal, attempts = DEFAULT_ATTEMPTS } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
        return await fetchOnce(url, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          throw error;
        }
        lastError = error;
        const retryable =
          error instanceof ShareResolveError
            ? error.retryable
            : isTransientNetworkError(error);
        if (!retryable || attempt === attempts - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  async function resolveMeta(token, { sort, signal, attempts } = {}) {
    const url = buildUrl(token, { phase: 'meta', sort });
    return fetchWithRetry(url, { signal, attempts });
  }

  async function resolveFull(token, { signal, attempts } = {}) {
    const url = buildUrl(token, {});
    return fetchWithRetry(url, { signal, attempts });
  }

  return {
    ShareResolveError,
    MESSAGES,
    DEFAULT_ATTEMPTS,
    resolveMeta,
    resolveFull,
    messageForCode,
    isPermanentFailure,
    isRetryable,
  };
})();

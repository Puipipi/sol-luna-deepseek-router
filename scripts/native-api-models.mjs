import { resolveApiCredential } from './native-api-settings.mjs';

const MAX_MODELS_RESPONSE_BYTES = 1_000_000;

function modelListUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  url.search = '';
  url.hash = '';
  return url;
}

/** Fetch model IDs only after an explicit caller action. Redirects are never followed. */
export async function listApiModels(profile, {
  env = process.env,
  readSecretFile,
  resolveAccount,
  resolveCredential = resolveApiCredential,
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Model list timeout must be from 1 to 60000 milliseconds.');
  }
  const auth = await resolveCredential(profile, {
    env,
    ...(readSecretFile ? {readSecretFile} : {}),
    ...(resolveAccount ? {resolveDeepSeekAuth: resolveAccount} : {}),
  });
  const headers = new Headers(auth?.headers || {});
  headers.set('accept', 'application/json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(modelListUrl(profile.baseUrl), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error('Model list redirects are blocked.');
    if (!response.ok) throw new Error(`Model list request failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MODELS_RESPONSE_BYTES) {
      throw new Error('Model list response is too large.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Model list response had no readable body.');
    const chunks = [];
    let total = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Model list response is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error('Model list response was not valid bounded JSON.'); }
    if (!Array.isArray(body?.data)) throw new Error('Model list response did not contain a data array.');
    const seen = new Set();
    const models = [];
    for (const item of body.data) {
      if (typeof item?.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || seen.has(item.id)) continue;
      seen.add(item.id);
      models.push(item.id);
      if (models.length === 2_000) break;
    }
    return models;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Model list request timed out.');
    if (error instanceof Error && /^(Model list (?:redirects|request failed with HTTP|response is too large|response had no readable body|response did not contain a data array)|Model list response was not valid bounded JSON)/.test(error.message)) throw error;
    throw new Error('Model list request failed; network details were omitted.');
  } finally {
    clearTimeout(timer);
  }
}

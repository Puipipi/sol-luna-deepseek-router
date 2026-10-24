import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  NativeApiProtocolError,
  chatCompletionToResponse,
  chatSseToResponses,
  normalizeNativeAgentMessages,
  normalizeOfficialDeepSeekResponsesRequest,
  responseErrorEvent,
  responsesRequestToChat,
} from "./native-api-protocol.mjs";
import { isOfficialDeepSeekProfile } from "./native-api-settings.mjs";

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length", "content-encoding", "set-cookie",
]);
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "user-agent", "x-request-id", "x-client-request-id"]);
const PROFILE_ID_RE = /^[a-f0-9]{24}$/;

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const payload = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length });
  res.end(payload);
}

function errorBody(message, code = "invalid_request_error") {
  return { error: { message, type: "invalid_request_error", code } };
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function localPath(pathname, token) {
  const parts = pathname.split("/");
  if (parts.length < 3 || !tokenMatches(parts[1], token)) return null;
  if (parts.length === 3 && parts[2] === "_health") return { kind: "health" };
  if (parts.length === 3 && parts[2] === "_shutdown") return { kind: "shutdown" };
  if (parts.length === 6 && parts[2] === "profiles" && PROFILE_ID_RE.test(parts[3]) && parts[4] === "v1" && parts[5] === "responses") {
    return { kind: "responses", profileId: parts[3] };
  }
  return null;
}

async function readBody(req, maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new NativeApiProtocolError("Request body is too large.", { status: 413, code: "request_too_large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateProfile(profile, profileId) {
  if (!profile || profile.profileId !== profileId || !["responses", "chat_completions"].includes(profile.protocol)
      || typeof profile.baseUrl !== "string" || typeof profile.model !== "string" || !profile.model) {
    throw new NativeApiProtocolError("Configured API profile is unavailable or invalid.", { status: 404, code: "profile_not_found" });
  }
  let base;
  try { base = new URL(profile.baseUrl); }
  catch { throw new NativeApiProtocolError("Configured profile baseUrl is invalid.", { status: 500, code: "invalid_profile" }); }
  if (!(["https:"].includes(base.protocol) || (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))
      || base.username || base.password || base.search || base.hash) {
    throw new NativeApiProtocolError("Configured profile baseUrl must be HTTPS, or loopback HTTP, without embedded credentials or query parameters.", { status: 500, code: "invalid_profile" });
  }
  if (profile.credential?.type === "dsh_account"
      && (profile.protocol !== "responses" || base.origin !== "https://api.deepseek.com" || !["", "/", "/v1"].includes(base.pathname))) {
    throw new NativeApiProtocolError("DSH account credentials are restricted to the official DeepSeek Responses endpoint.", { status: 403, code: "credential_endpoint_restricted" });
  }
  return base;
}

function upstreamHeaders(req, authHeaders) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(req.headers)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const injected = authHeaders instanceof Headers ? authHeaders : new Headers(authHeaders || {});
  for (const [name, value] of injected) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || ["cookie", "host", "content-length", "content-encoding"].includes(lower)) continue;
    headers.set(name, value);
  }
  return headers;
}

function filteredResponseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  return headers;
}

function endpoint(base, path) {
  const prefix = base.toString().replace(/\/$/, "");
  return new URL(`${prefix}/${path}`);
}

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createNativeApiGateway({
  resolveProfile,
  resolveAuth,
  fetchImpl = fetch,
  token = randomBytes(32).toString("base64url"),
  timeoutMs = 120_000,
  maxRequestBytes = 64 * 1024 * 1024,
  logger = console,
  health = null,
  onShutdown = null,
} = {}) {
  if (typeof resolveProfile !== "function") throw new TypeError("resolveProfile is required");
  if (typeof resolveAuth !== "function") throw new TypeError("resolveAuth is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof token !== "string" || token.length < 8) throw new TypeError("token must contain at least 8 characters");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new RangeError("maxRequestBytes must be a positive safe integer");
  if (health !== null && (typeof health !== "object" || Array.isArray(health))) throw new TypeError("health must be an object");
  if (onShutdown !== null && typeof onShutdown !== "function") throw new TypeError("onShutdown must be a function");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = localPath(url.pathname, token);
    if (!route) { json(res, 404, errorBody("Not found.", "not_found")); return; }
    if (route.kind === "health") {
      if (req.method !== "GET") { json(res, 405, errorBody("GET only.", "method_not_allowed")); return; }
      json(res, 200, { ok: true, pid: process.pid, ...(health || {}) });
      return;
    }
    if (route.kind === "shutdown") {
      if (req.method !== "POST") { json(res, 405, errorBody("POST only.", "method_not_allowed")); return; }
      if (typeof onShutdown !== "function") { json(res, 404, errorBody("Not found.", "not_found")); return; }
      if (!tokenMatches(req.headers["x-sol-luna-token"], token)) {
        json(res, 403, errorBody("Shutdown token is invalid.", "forbidden"));
        return;
      }
      json(res, 200, { ok: true, pid: process.pid });
      setImmediate(() => onShutdown());
      return;
    }
    if (req.method !== "POST") { json(res, 405, errorBody("POST only.", "method_not_allowed")); return; }
    if (url.search) { json(res, 400, errorBody("Query parameters are not supported on this route.", "unsupported_parameter")); return; }
    if (req.headers["content-encoding"] && !["identity"].includes(String(req.headers["content-encoding"]).toLowerCase())) {
      json(res, 415, errorBody("Compressed request bodies are not supported.", "unsupported_content_encoding"));
      return;
    }

    const requestStarted = Date.now();
    let upstreamStarted = false;
    let streamStarted = false;
    let clientDisconnected = false;
    let timedOut = false;
    let controller;
    let timeout;
    const log = (fields) => {
      try { logger?.info?.({ kind: "native_api", ...fields }); } catch { /* logging is best-effort */ }
    };
    try {
      const raw = await readBody(req, maxRequestBytes);
      if (req.aborted || res.destroyed) return;
      if (req.headers["content-type"] && !String(req.headers["content-type"]).toLowerCase().includes("application/json")) {
        throw new NativeApiProtocolError("Content-Type must be application/json.", { status: 415, code: "unsupported_media_type" });
      }
      let body;
      try { body = JSON.parse(raw.toString("utf8")); }
      catch { throw new NativeApiProtocolError("Request body must be valid JSON.", { status: 400, code: "invalid_json" }); }
      const profile = await resolveProfile({ profileId: route.profileId });
      const base = validateProfile(profile, route.profileId);
      if (body?.model !== profile.model) throw new NativeApiProtocolError("Request model does not match the selected profile.", { status: 400, code: "model_mismatch" });

      let outgoing;
      let toolMap = new Map();
      if (profile.protocol === "responses") {
        const normalized = isOfficialDeepSeekProfile(profile)
          ? normalizeOfficialDeepSeekResponsesRequest(body, profile)
          : normalizeNativeAgentMessages(body);
        outgoing = Buffer.from(JSON.stringify(normalized));
      } else {
        const converted = responsesRequestToChat(body, profile);
        outgoing = Buffer.from(JSON.stringify(converted.body));
        toolMap = converted.toolMap;
      }
      let auth;
      try { auth = await resolveAuth(profile); }
      catch { throw new NativeApiProtocolError("The selected profile has no usable credential.", { status: 503, code: "credential_unavailable" }); }
      if (!auth || typeof auth !== "object" || !auth.headers) {
        throw new NativeApiProtocolError("The selected profile has no usable credential.", { status: 503, code: "credential_unavailable" });
      }
      const headers = upstreamHeaders(req, auth.headers);
      if (!headers.has("accept")) headers.set("accept", body.stream === true ? "text/event-stream" : "application/json");
      const targetPath = profile.protocol === "responses" ? "responses" : "chat/completions";
      const target = endpoint(base, targetPath);
      controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded && !timedOut) {
          clientDisconnected = true;
          log({ phase: "client_disconnect", status: 499, stream_started: streamStarted || res.headersSent });
          controller.abort(new Error("Client disconnected."));
        }
      };
      res.once("close", onClose);
      timeout = setTimeout(() => {
        if (res.writableEnded) return;
        timedOut = true;
        log({ phase: "timeout", status: 504, timeout_ms: timeoutMs, stream_started: streamStarted || res.headersSent, latency_ms: Date.now() - requestStarted });
        controller.abort(new Error("Upstream request timed out."));
        if (!res.headersSent) json(res, 504, errorBody("Upstream request timed out.", "timeout"));
        else if (!(profile.protocol === "chat_completions" && body.stream === true)) res.destroy();
      }, timeoutMs);

      upstreamStarted = true;
      const upstream = await fetchImpl(target, { method: "POST", headers, body: outgoing, redirect: "error", signal: controller.signal });
      if (profile.protocol === "responses") {
        res.writeHead(upstream.status, filteredResponseHeaders(upstream));
        streamStarted = true;
        if (!upstream.body) { res.end(); return; }
        Readable.fromWeb(upstream.body).on("error", (error) => res.destroy(error)).pipe(res);
        return;
      }
      if (!upstream.ok) {
        const errorBytes = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, filteredResponseHeaders(upstream));
        res.end(errorBytes);
        return;
      }
      if (body.stream !== true) {
        let completion;
        try { completion = await upstream.json(); }
        catch { throw new NativeApiProtocolError("Chat upstream returned invalid JSON.", { status: 502, code: "invalid_upstream_response" }); }
        const response = chatCompletionToResponse(completion, { requestId: completion.id, model: profile.model, profile, toolMap });
        const payload = Buffer.from(`${JSON.stringify(response)}\n`);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": payload.length });
        res.end(payload);
        return;
      }
      if (!upstream.body) throw new NativeApiProtocolError("Chat upstream omitted the requested SSE stream.", { status: 502, code: "invalid_upstream_response" });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      streamStarted = true;
      const requestId = `api_${Date.now().toString(36)}`;
      try {
        for await (const event of chatSseToResponses(upstream.body, { requestId, model: profile.model, profile, toolMap })) {
          if (timedOut) {
            const timeoutEvent = responseErrorEvent({ requestId, model: profile.model, message: "Upstream request timed out.", code: "timeout" });
            if (!res.destroyed) res.write(sse(timeoutEvent));
            break;
          }
          if (res.destroyed || clientDisconnected) break;
          if (!res.write(sse(event))) await once(res, "drain");
        }
        if (!res.destroyed && !res.writableEnded) res.end();
      } catch (error) {
        if (timedOut && !res.destroyed) res.write(sse(responseErrorEvent({ requestId, model: profile.model, message: "Upstream request timed out.", code: "timeout" })));
        else if (!clientDisconnected) throw error;
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const code = error?.code || "upstream_error";
      const message = error?.message || "Native API gateway request failed.";
      log({ phase: "error", status: timedOut ? 504 : status, code, latency_ms: Date.now() - requestStarted, upstream_started: upstreamStarted });
      if (clientDisconnected || req.aborted || res.destroyed) return;
      if (timedOut) {
        if (!res.headersSent) json(res, 504, errorBody("Upstream request timed out.", "timeout"));
        else res.destroy();
      } else if (!res.headersSent) {
        json(res, status, errorBody(message, code));
      } else {
        res.destroy(error);
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  return {
    server,
    token,
    async start(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      return { port: address.port, address, baseUrl: `http://127.0.0.1:${address.port}/${token}` };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}


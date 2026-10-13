const sessions = new Map();

const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;
const MAX_COOKIES_PER_SESSION = 3_000;
const MAX_COOKIE_BYTES = 4096;
let nextSessionCleanupAt = 0;

function parseHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("A valid HTTP or HTTPS page URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("A valid HTTP or HTTPS page URL is required.");
  }
  return url;
}

function getSession(sessionId, create = false) {
  if (!SESSION_ID_PATTERN.test(sessionId || "")) return null;
  const now = Date.now();
  if (now >= nextSessionCleanupAt) {
    for (const [id, session] of sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(id);
    }
    nextSessionCleanupAt = now + 60_000;
  }

  let session = sessions.get(sessionId);
  if (!session && create) {
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error("The proxy has reached its active browser-session limit.");
    }
    session = { cookies: new Map(), updatedAt: now };
    sessions.set(sessionId, session);
  }
  if (session) session.updatedAt = now;
  return session || null;
}

function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function parseCookie(sessionId, rawUrl, setCookie) {
  if (typeof setCookie !== "string" || Buffer.byteLength(setCookie) > MAX_COOKIE_BYTES) return;
  const url = parseHttpUrl(rawUrl);
  const parts = setCookie.split(";");
  const separator = parts[0].indexOf("=");
  if (separator <= 0) return;

  const name = parts[0].slice(0, separator).trim();
  const value = parts[0].slice(separator + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u0020\u007f;,]/.test(value)) return;

  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let cookiePath = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
  let secure = false;
  let httpOnly = false;
  let expiresAt = null;
  let maxAge;

  for (const rawAttribute of parts.slice(1)) {
    const attribute = rawAttribute.trim();
    const equals = attribute.indexOf("=");
    const key = (equals < 0 ? attribute : attribute.slice(0, equals)).toLowerCase();
    const attributeValue = equals < 0 ? "" : attribute.slice(equals + 1).trim();
    if (key === "domain") {
      const candidate = attributeValue.replace(/^\./, "").toLowerCase();
      if (!candidate || !domainMatches(url.hostname.toLowerCase(), candidate)) return;
      domain = candidate;
      hostOnly = false;
    } else if (key === "path" && attributeValue.startsWith("/")) {
      cookiePath = attributeValue;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "httponly") {
      httpOnly = true;
    } else if (key === "max-age" && /^-?\d+$/.test(attributeValue)) {
      maxAge = Number(attributeValue);
    } else if (key === "expires") {
      const date = Date.parse(attributeValue);
      if (Number.isFinite(date)) expiresAt = date;
    }
  }

  if (maxAge !== undefined) expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
  const session = getSession(sessionId, true);
  if (!session) return;
  const key = `${domain}\n${cookiePath}\n${name}`;
  if (expiresAt !== null && expiresAt <= Date.now()) {
    session.cookies.delete(key);
    return;
  }
  if (!session.cookies.has(key) && session.cookies.size >= MAX_COOKIES_PER_SESSION) {
    throw new Error("This browser session has reached its cookie limit.");
  }

  session.cookies.set(key, { name, value, domain, hostOnly, path: cookiePath, secure, httpOnly, expiresAt });
}

function matchingCookies(sessionId, rawUrl) {
  const url = parseHttpUrl(rawUrl);
  const session = getSession(sessionId);
  if (!session) return [];
  const now = Date.now();
  const matches = [];
  for (const [key, cookie] of session.cookies) {
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
      session.cookies.delete(key);
      continue;
    }
    const domainMatchesRequest = cookie.hostOnly
      ? url.hostname.toLowerCase() === cookie.domain
      : domainMatches(url.hostname.toLowerCase(), cookie.domain);
    if (
      domainMatchesRequest &&
      pathMatches(url.pathname, cookie.path) &&
      (!cookie.secure || url.protocol === "https:")
    ) {
      matches.push(cookie);
    }
  }
  return matches.sort((left, right) => right.path.length - left.path.length);
}

function getRequestCookieHeader(sessionId, rawUrl) {
  return matchingCookies(sessionId, rawUrl)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

function getDocumentCookieString(sessionId, rawUrl) {
  return matchingCookies(sessionId, rawUrl)
    .filter((cookie) => !cookie.httpOnly)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

function storeResponseCookies(sessionId, rawUrl, setCookies) {
  for (const setCookie of setCookies || []) parseCookie(sessionId, rawUrl, setCookie);
}

function storeDocumentCookie(sessionId, rawUrl, setCookie) {
  parseCookie(sessionId, rawUrl, setCookie);
}

module.exports = {
  getDocumentCookieString,
  getRequestCookieHeader,
  storeDocumentCookie,
  storeResponseCookies,
};

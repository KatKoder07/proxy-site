const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const {
  getDocumentCookieString,
  getRequestCookieHeader,
  storeDocumentCookie,
  storeResponseCookies,
} = require("./cookie-jar.cjs");

const APP_HOST = process.env.HOST || "127.0.0.1";
const APP_PORT = Number(process.env.PORT || 4173);
const PROXY_ONLY = process.env.PROXY_ONLY === "true";
const PROXY_PORT = Number(process.env.PROXY_PORT || (PROXY_ONLY && process.env.PORT ? process.env.PORT : APP_PORT + 1));
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_COOKIE_UPDATE_BYTES = 4096;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
ALLOWED_ORIGINS.add("null");
ALLOWED_ORIGINS.add("http://localhost:4173");
ALLOWED_ORIGINS.add("http://127.0.0.1:4173");
const PUBLIC_PROXY_ORIGIN = process.env.PUBLIC_PROXY_ORIGIN
  ? new URL(process.env.PUBLIC_PROXY_ORIGIN).origin
  : "";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function isPublicAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];

  if (net.isIPv4(normalized)) {
    const octets = normalized.split(".").map(Number);
    const [a, b] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && octets[2] === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      a >= 224
    );
  }

  if (net.isIPv6(normalized)) {
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      return net.isIPv4(mapped) && isPublicAddress(mapped);
    }
    return (
      normalized !== "::" &&
      normalized !== "::1" &&
      !normalized.startsWith("fc") &&
      !normalized.startsWith("fd") &&
      !normalized.startsWith("fe8") &&
      !normalized.startsWith("fe9") &&
      !normalized.startsWith("fea") &&
      !normalized.startsWith("feb") &&
      (normalized.startsWith("2") || normalized.startsWith("3")) &&
      !normalized.startsWith("2001:db8")
    );
  }

  return false;
}

async function resolvePublicAddresses(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new Error("Private and reserved network addresses are blocked.");
    }
    return [{ address: hostname, family: net.isIP(hostname) }];
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("This destination resolves to a private or reserved network address.");
  }
  return addresses;
}

async function validateTarget(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("Enter a valid web address.");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only HTTP and HTTPS addresses are supported.");
  }
  if (target.username || target.password) {
    throw new Error("Addresses containing credentials are not supported.");
  }
  const standardPort = target.protocol === "https:" ? "443" : "80";
  if (target.port && target.port !== standardPort) {
    throw new Error("Only standard web ports are supported.");
  }

  await resolvePublicAddresses(target.hostname);
  target.hash = "";
  return target;
}

function createPinnedLookup(addresses) {
  let next = 0;
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, addresses);
      return;
    }
    const result = addresses[next % addresses.length];
    next += 1;
    callback(null, result.address, result.family);
  };
}

function requestUpstream(target, method, headers, body, sessionId, redirects = 0) {
  return new Promise(async (resolve, reject) => {
    let addresses;
    try {
      addresses = await resolvePublicAddresses(target.hostname);
    } catch (error) {
      reject(error);
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const outgoingHeaders = {
      "user-agent": "VeilBrowser/1.0 (+local web proxy)",
      accept: headers.accept || "*/*",
      "accept-language": headers["accept-language"] || "en-US,en;q=0.8",
      host: target.host,
    };
    const cookieHeader = getRequestCookieHeader(sessionId, target.href);
    if (cookieHeader) outgoingHeaders.cookie = cookieHeader;
    for (const name of ["range", "if-range"]) {
      if (headers[name]) outgoingHeaders[name] = headers[name];
    }
    if (body.length && headers["content-type"]) {
      outgoingHeaders["content-type"] = headers["content-type"];
      outgoingHeaders["content-length"] = body.length;
    }

    const outgoing = transport.request(
      target,
      {
        method,
        headers: outgoingHeaders,
        lookup: createPinnedLookup(addresses),
        servername: target.hostname,
        timeout: REQUEST_TIMEOUT_MS,
      },
      async (incoming) => {
        const status = incoming.statusCode || 502;
        const location = incoming.headers.location;
        storeResponseCookies(sessionId, target.href, incoming.headers["set-cookie"]);
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          incoming.resume();
          if (redirects >= 5) {
            reject(new Error("The destination redirected too many times."));
            return;
          }
          try {
            const nextTarget = await validateTarget(new URL(location, target).href);
            const nextMethod = status === 303 || ((status === 301 || status === 302) && method === "POST")
              ? "GET"
              : method;
            resolve(requestUpstream(nextTarget, nextMethod, headers, nextMethod === "GET" ? Buffer.alloc(0) : body, sessionId, redirects + 1));
          } catch (error) {
            reject(error);
          }
          return;
        }

        const chunks = [];
        let size = 0;
        incoming.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            incoming.destroy(new Error("The destination response exceeded the 10 MB limit."));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            status,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          });
        });
        incoming.on("error", reject);
      },
    );

    outgoing.on("timeout", () => outgoing.destroy(new Error("The destination took too long to respond.")));
    outgoing.on("error", reject);
    if (body.length && method !== "HEAD") outgoing.write(body);
    outgoing.end();
  });
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const codePoint = parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#([0-9]+);/g, (match, dec) => {
      const codePoint = Number(dec);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    });
}

function proxyUrl(targetUrl, proxyOrigin, sessionId) {
  const query = new URLSearchParams({ url: targetUrl });
  if (sessionId) query.set("session", sessionId);
  return `${proxyOrigin}/proxy?${query}`;
}

function proxiedUrl(value, sourceUrl, proxyOrigin, sessionId) {
  const raw = decodeHtmlAttribute(value.trim());
  if (!raw || /^(?:#|data:|blob:|javascript:|mailto:|tel:)/i.test(raw)) return value;
  try {
    const absolute = new URL(raw, sourceUrl);
    if (!["http:", "https:"].includes(absolute.protocol)) return value;
    return proxyUrl(absolute.href, proxyOrigin, sessionId);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, sourceUrl, proxyOrigin, sessionId) {
  return value.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0] || /^data:/i.test(parts[0])) return candidate;
    parts[0] = proxiedUrl(parts[0], sourceUrl, proxyOrigin, sessionId);
    return parts.join(" ");
  }).join(", ");
}

function rewriteCss(css, sourceUrl, proxyOrigin, sessionId) {
  const route = (raw) => proxiedUrl(raw, sourceUrl, proxyOrigin, sessionId);
  return css.replace(
    /@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?|url\(\s*(['"]?)(.*?)\3\s*\)/gi,
    (whole, _importQuote, importValue, _urlQuote, urlValue) =>
      importValue === undefined
        ? `url("${route(urlValue)}")`
        : `@import url("${route(importValue)}")`,
  );
}

function rewriteHtml(html, sourceUrl, proxyOrigin, sessionId) {
  const urlAttributes = new Set(["href", "src", "action", "poster", "data", "xlink:href"]);
  const rewritten = html.replace(/<([a-z][\w:-]*)(\s[^<>]*?)?>/gi, (tagText, _tag, attributes = "") => {
    const next = attributes.replace(
      /(\s[\w:-]+\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (attribute, prefix, doubleQuoted, singleQuoted, unquoted) => {
        const name = prefix.trim().split("=")[0].trim().toLowerCase();
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
        let nextValue = value;
        if (urlAttributes.has(name)) nextValue = proxiedUrl(value, sourceUrl, proxyOrigin, sessionId);
        if (name === "srcset") nextValue = rewriteSrcset(value, sourceUrl, proxyOrigin, sessionId);
        if (name === "style") nextValue = rewriteCss(value, sourceUrl, proxyOrigin, sessionId);
        return `${prefix}"${nextValue.replace(/"/g, "&quot;")}"`;
      },
    );
    return `<${_tag}${next}>`;
  });
  const withCss = rewritten.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_whole, open, css, close) =>
    `${open}${rewriteCss(css, sourceUrl, proxyOrigin, sessionId)}${close}`);

  const scriptValue = (value) => JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const runtime = `<script>(${proxyRuntime.toString()})(${scriptValue(sourceUrl)},${scriptValue(proxyOrigin)},${scriptValue(sessionId)},${scriptValue(getDocumentCookieString(sessionId, sourceUrl))});</script>`;
  const headIndex = withCss.search(/<head(?:\s[^>]*)?>/i);
  if (headIndex >= 0) {
    const end = withCss.indexOf(">", headIndex) + 1;
    return `${withCss.slice(0, end)}${runtime}${withCss.slice(end)}`;
  }
  return `${runtime}${withCss}`;
}

function proxyRuntime(sourceUrl, proxyOrigin, sessionId, initialCookies) {
  const notify = (input) => {
    try {
      const candidate = new URL(String(input), sourceUrl);
      const url = candidate.origin === new URL(proxyOrigin).origin && candidate.pathname === "/proxy"
        ? new URL(candidate.searchParams.get("url") || sourceUrl)
        : candidate;
      if (["http:", "https:"].includes(url.protocol)) {
        parent.postMessage({ type: "veil:navigate", url: url.href }, "*");
      }
    } catch {
      return;
    }
  };
  const route = (input) => {
    try {
      const url = new URL(String(input), sourceUrl);
      if (!["http:", "https:"].includes(url.protocol)) return input;
      const query = new URLSearchParams({ url: url.href });
      if (sessionId) query.set("session", sessionId);
      return `${proxyOrigin}/proxy?${query}`;
    } catch {
      return input;
    }
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) {
      return originalFetch(route(input), init);
    }
    return originalFetch(input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return originalOpen.call(this, method, route(url), ...rest);
  };

  const documentCookie = { value: initialCookies };
  Object.defineProperty(document, "cookie", {
    configurable: true,
    enumerable: true,
    get: () => documentCookie.value,
    set: (value) => {
      const cookie = String(value).split(";", 1)[0].trim();
      const separator = cookie.indexOf("=");
      if (separator <= 0) return;
      const name = cookie.slice(0, separator).trim();
      const nextValue = cookie.slice(separator + 1).trim();
      const entries = new Map(documentCookie.value.split(/;\s*/).filter(Boolean).map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }));
      const expired = /(?:^|;)\s*max-age\s*=\s*(?:0|-\d+)/i.test(String(value)) ||
        (() => {
          const expires = String(value).match(/(?:^|;)\s*expires\s*=\s*([^;]+)/i);
          return expires ? Date.parse(expires[1]) <= Date.now() : false;
        })();
      if (expired) entries.delete(name);
      else entries.set(name, nextValue);
      documentCookie.value = [...entries].map(([key, entry]) => `${key}=${entry}`).join("; ");
      originalFetch(`${proxyOrigin}/cookies?session=${encodeURIComponent(sessionId)}&url=${encodeURIComponent(sourceUrl)}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: String(value),
        keepalive: true,
      }).then((response) => {
        if (!response.ok) console.error("Veil could not save this site's cookie.");
      }).catch((error) => console.error("Veil could not save this site's cookie:", error));
    },
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (anchor) notify(anchor.href);
  }, true);
  document.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement) notify(event.target.action || sourceUrl);
  }, true);
  const originalPushState = history.pushState.bind(history);
  history.pushState = (state, title, url) => {
    const result = originalPushState(state, title, url);
    if (url !== undefined) notify(url);
    return result;
  };
  addEventListener("popstate", () => notify(location.href));

  const rewriteElement = (element) => {
    for (const name of ["href", "src", "action", "poster", "data"]) {
      const value = element.getAttribute(name);
      if (value && !value.startsWith(`${proxyOrigin}/proxy?url=`)) {
        const rewritten = route(value);
        if (rewritten !== value) element.setAttribute(name, rewritten);
      }
    }
  };
  const scan = (root) => {
    if (root.nodeType === 1) rewriteElement(root);
    if (root.querySelectorAll) root.querySelectorAll("[href], [src], [action], [poster], [data]").forEach(rewriteElement);
  };
  scan(document);
  new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(scan)))
    .observe(document.documentElement, { childList: true, subtree: true });
}

function proxyError(res, status, message) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>Unable to open page</title><main style="font:16px system-ui;max-width:40rem;margin:12vh auto;padding:24px;color:#182233"><h1>Unable to open this page</h1><p>${escapeHtml(message)}</p></main>`);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("The submitted form exceeded the 1 MB limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const appServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${APP_HOST}:${APP_PORT}`).pathname;
  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: "ok", proxy: `http://${APP_HOST}:${PROXY_PORT}` }));
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const contents = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(contents);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Static file error:", error.message);
    res.writeHead(error.code === "ENOENT" ? 404 : 500);
    res.end(error.code === "ENOENT" ? "Not found" : "Unable to read this file");
  }
});

const proxyServer = http.createServer(async (req, res) => {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http"))
    .split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0].trim();
  const proxyOrigin = PUBLIC_PROXY_ORIGIN || `${forwardedProto}://${forwardedHost}`;
  try {
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== proxyOrigin && !ALLOWED_ORIGINS.has(requestOrigin)) {
      proxyError(res, 403, "Requests from this website are not allowed.");
      return;
    }
    if (requestOrigin) {
      res.setHeader("access-control-allow-origin", requestOrigin);
      res.setHeader("vary", "Origin");
    }
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "Content-Type, Accept");

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-max-age": "600" });
      res.end();
      return;
    }
    const incomingUrl = new URL(req.url, proxyOrigin);
    let sessionId = incomingUrl.searchParams.get("session") || "";
    if (incomingUrl.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ status: "ok", proxy: proxyOrigin }));
      return;
    }
    if (incomingUrl.pathname === "/cookies") {
      if (req.method !== "POST" || !sessionId) {
        proxyError(res, 400, "A browser session is required to update cookies.");
        return;
      }
      const pageUrl = incomingUrl.searchParams.get("url");
      if (!pageUrl) {
        proxyError(res, 400, "A page URL is required to update cookies.");
        return;
      }
      await validateTarget(pageUrl);
      const cookie = await readBody(req);
      if (cookie.length > MAX_COOKIE_UPDATE_BYTES) {
        proxyError(res, 413, "The cookie exceeded the 4 KB limit.");
        return;
      }
      storeDocumentCookie(sessionId, pageUrl, cookie.toString("utf8"));
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    let targetValue = incomingUrl.searchParams.get("url");

    if (!targetValue && req.headers.referer) {
      const referer = new URL(req.headers.referer);
      const refererTarget = new URL(referer.searchParams.get("url") || "");
      if (!sessionId) sessionId = referer.searchParams.get("session") || "";
      targetValue = new URL(incomingUrl.pathname + incomingUrl.search, refererTarget).href;
    }
    if (!targetValue) {
      proxyError(res, 400, "Choose a web address to open.");
      return;
    }
    if (!["GET", "HEAD", "POST"].includes(req.method)) {
      proxyError(res, 405, "This request method is not supported.");
      return;
    }

    const target = await validateTarget(targetValue);
    const body = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
    const result = await requestUpstream(target, req.method, req.headers, body, sessionId);
    const contentType = String(result.headers["content-type"] || "application/octet-stream");
    let responseBody = result.body;
    if (/text\/html/i.test(contentType)) {
      responseBody = Buffer.from(rewriteHtml(responseBody.toString("utf8"), target.href, proxyOrigin, sessionId));
    } else if (/text\/css/i.test(contentType)) {
      responseBody = Buffer.from(rewriteCss(responseBody.toString("utf8"), target.href, proxyOrigin, sessionId));
    }

    const responseHeaders = {
      "content-type": contentType,
      "cache-control": "no-store",
      "content-length": responseBody.length,
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
    };
    for (const name of ["accept-ranges", "content-range", "content-disposition", "etag", "last-modified"]) {
      if (result.headers[name]) responseHeaders[name] = result.headers[name];
    }
    res.writeHead(result.status, responseHeaders);
    if (req.method === "HEAD") res.end();
    else res.end(responseBody);
  } catch (error) {
    const isClientError = /valid web address|Only HTTP|credentials|standard web ports|private or reserved|network address|redirected too many|method is not supported|exceeded the 1 MB/i.test(error.message);
    const status = /exceeded|too long/i.test(error.message) ? 413 : isClientError ? 400 : 502;
    console.error("Proxy request failed:", error.message);
    proxyError(res, status, error.message || "The remote website could not be reached.");
  }
});

appServer.on("error", (error) => {
  console.error(`App server could not listen on ${APP_HOST}:${APP_PORT}: ${error.message}`);
  process.exitCode = 1;
});
proxyServer.on("error", (error) => {
  console.error(`Proxy server could not listen on ${APP_HOST}:${PROXY_PORT}: ${error.message}`);
  appServer.close();
  process.exitCode = 1;
});

if (!PROXY_ONLY) {
  appServer.listen(APP_PORT, APP_HOST, () => {
    console.log(`Veil Browser: http://${APP_HOST}:${APP_PORT}`);
  });
}
proxyServer.listen(PROXY_PORT, APP_HOST, () => {
  console.log(`Proxy listening on ${APP_HOST}:${PROXY_PORT}`);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDocumentCookieString,
  getRequestCookieHeader,
  storeDocumentCookie,
  storeResponseCookies,
} = require("../cookie-jar.cjs");

const firstSession = "a".repeat(64);
const secondSession = "b".repeat(64);
const cookieReadSession = "c".repeat(64);
const pathSession = "d".repeat(64);
const invalidDomainSession = "e".repeat(64);

test("keeps cookies isolated by browser session and site domain", () => {
  storeResponseCookies(firstSession, "https://play.example.com/", [
    "sid=one; Path=/; Secure; HttpOnly",
    "wide=two; Domain=example.com; Path=/",
  ]);
  storeResponseCookies(secondSession, "https://play.example.com/", [
    "sid=other; Path=/; Secure; HttpOnly",
  ]);

  assert.equal(getRequestCookieHeader(firstSession, "https://play.example.com/"), "sid=one; wide=two");
  assert.equal(getRequestCookieHeader(secondSession, "https://play.example.com/"), "sid=other");
  assert.equal(getRequestCookieHeader(firstSession, "https://unrelated.test/"), "");
  assert.equal(getRequestCookieHeader(firstSession, "http://play.example.com/"), "wide=two");
});

test("exposes ordinary cookies to page scripts but hides HttpOnly cookies", () => {
  storeResponseCookies(cookieReadSession, "https://play.example.com/", [
    "session=private; Path=/; HttpOnly; Secure",
    "theme=dark; Path=/; Secure",
  ]);

  assert.equal(getDocumentCookieString(cookieReadSession, "https://play.example.com/"), "theme=dark");
});

test("honors cookie paths, updates, and deletion", () => {
  storeDocumentCookie(pathSession, "https://play.example.com/games/page", "scope=games; Path=/games");
  assert.equal(getRequestCookieHeader(pathSession, "https://play.example.com/games/next"), "scope=games");
  assert.equal(getRequestCookieHeader(pathSession, "https://play.example.com/account"), "");

  storeDocumentCookie(pathSession, "https://play.example.com/games/page", "scope=; Path=/games; Max-Age=0");
  assert.equal(getRequestCookieHeader(pathSession, "https://play.example.com/games/next"), "");
});

test("rejects cookies attempting to set an unrelated domain", () => {
  storeResponseCookies(invalidDomainSession, "https://play.example.com/", [
    "bad=one; Domain=attacker.test; Path=/",
  ]);
  assert.equal(getRequestCookieHeader(invalidDomainSession, "https://play.example.com/"), "");
});

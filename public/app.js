(() => {
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname) ||
    window.location.protocol === "file:";
  const localProxyOrigin = `http://${window.location.hostname || "127.0.0.1"}:${Number(window.location.port || 4173) + 1}`;
  let PROXY_ORIGIN = String(window.VEIL_PROXY_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!PROXY_ORIGIN && isLocal) PROXY_ORIGIN = localProxyOrigin;
  const HISTORY_KEY = "veil.history.v1";
  const SAVED_KEY = "veil.saved.v1";
  const SHORTCUTS_KEY = "veil.shortcuts.v1";
  const PROXY_SESSION_KEY = "veil.proxy-session.v1";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const homeView = $("#homeView");
  const browserView = $("#browserView");
  const collectionView = $("#collectionView");
  const addressInput = $("#addressInput");
  const browserAddress = $("#browserAddress");
  const proxyFrame = $("#proxyFrame");
  const frameLoading = $("#frameLoading");
  const toast = $("#toast");
  let proxySessionId = readProxySessionId();
  let currentUrl = "";
  let toastTimer;
  let loadingTimer;
  let savedPages = readStorage(SAVED_KEY, []);
  let shortcuts = readStorage(SHORTCUTS_KEY, []);

  function readStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return Array.isArray(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function readProxySessionId() {
    try {
      let id = localStorage.getItem(PROXY_SESSION_KEY);
      if (!/^[a-f0-9]{64}$/i.test(id || "")) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        localStorage.setItem(PROXY_SESSION_KEY, id);
      }
      return id;
    } catch (error) {
      console.error("Could not initialize the private proxy cookie session:", error);
      return "";
    }
  }

  function writeStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function historyItems() {
    return readStorage(HISTORY_KEY, []);
  }

  function formatAddress(value) {
    const input = value.trim();
    if (!input) return "";
    if (/^(?:https?:\/\/|\/\/)/i.test(input)) {
      try {
        return new URL(input.startsWith("//") ? `https:${input}` : input).href;
      } catch {
        return `https://${input.replace(/^https?:\/\//i, "")}`;
      }
    }
    if (/^(?:localhost|[\w-]+\.)+[\w-]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(input)) {
      return `https://${input}`;
    }
    return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  }

  function siteName(value) {
    try {
      return new URL(value).hostname.replace(/^www\./, "");
    } catch {
      return value;
    }
  }

  function displayTime(timestamp) {
    const date = new Date(timestamp);
    const elapsed = Date.now() - date.getTime();
    if (elapsed < 60_000) return "Just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function toastMessage(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function proxyUrl(value) {
    const query = new URLSearchParams({ url: value });
    if (proxySessionId) query.set("session", proxySessionId);
    return `${PROXY_ORIGIN}/proxy?${query}`;
  }

  function navigate(raw) {
    if (!PROXY_ORIGIN) {
      toastMessage("Set the proxy URL in config.js before browsing.");
      return;
    }
    const destination = formatAddress(raw);
    if (!destination) {
      addressInput.focus();
      return;
    }
    currentUrl = destination;
    browserAddress.value = destination;
    frameLoading.classList.remove("hidden");
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => frameLoading.classList.add("hidden"), 15_000);
    proxyFrame.src = proxyUrl(destination);
    showView("browser");
    const pages = historyItems().filter((item) => item.url !== destination);
    pages.unshift({ url: destination, visitedAt: Date.now() });
    writeStorage(HISTORY_KEY, pages.slice(0, 60));
  }

  function showView(name) {
    $$(".view").forEach((view) => view.classList.remove("active"));
    const active = name === "browser" ? browserView : name === "home" ? homeView : collectionView;
    active.classList.add("active");
    const title = name === "saved" ? "Saved pages" : name === "history" ? "History" : name === "browser" ? "Browsing" : "Home";
    $("#breadcrumbPage").textContent = title;
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    if (name === "history" || name === "saved") renderCollection(name);
    if (name !== "browser") {
      $("#sidebar").classList.remove("open");
      renderRecent();
    }
  }

  function favLetter(value) {
    return siteName(value).charAt(0).toUpperCase() || "↗";
  }

  function renderRecent() {
    const recent = historyItems().slice(0, 3);
    const container = $("#recentList");
    if (!recent.length) {
      container.innerHTML = '<div class="empty-state"><span>◷</span><p>Your recent pages will show up here.</p></div>';
      return;
    }
    container.innerHTML = recent.map((item) => `
      <div class="recent-row" data-url="${escapeAttribute(item.url)}">
        <span class="site-favicon">${escapeHtml(favLetter(item.url))}</span>
        <span class="recent-title"><strong>${escapeHtml(siteName(item.url))}</strong><small>${escapeHtml(item.url)}</small></span>
        <span class="recent-time">${displayTime(item.visitedAt)}</span>
      </div>`).join("");
    container.querySelectorAll("[data-url]").forEach((row) => row.addEventListener("click", () => navigate(row.dataset.url)));
  }

  function renderCollection(kind) {
    const saved = kind === "saved";
    const entries = saved ? savedPages : historyItems();
    $("#collectionTitle").textContent = saved ? "Saved pages" : "History";
    $("#collectionSubtitle").textContent = saved ? "Your bookmarked corners of the web." : "Pages you’ve visited on this device.";
    $("#clearCollection").textContent = saved ? "Clear saved pages" : "Clear history";
    const content = $("#collectionContent");
    if (!entries.length) {
      content.innerHTML = `<div class="collection-empty">${saved ? "Your saved pages will appear here." : "Pages you visit will appear here."}</div>`;
      return;
    }
    if (saved) {
      content.innerHTML = `<div class="collection-group"><h2>YOUR SAVED PAGES</h2>${entries.map((item) => collectionRow(item, false)).join("")}</div>`;
      bindCollectionRows(content);
      return;
    }
    const grouped = new Map();
    entries.forEach((item) => {
      const key = new Date(item.visitedAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      grouped.set(key, [...(grouped.get(key) || []), item]);
    });
    content.innerHTML = [...grouped].map(([date, items]) => `<div class="collection-group"><h2>${escapeHtml(date.toUpperCase())}</h2>${items.map((item) => collectionRow(item, true)).join("")}</div>`).join("");
    bindCollectionRows(content);
  }

  function collectionRow(item, showTime) {
    return `<div class="collection-row" data-url="${escapeAttribute(item.url)}"><span class="site-favicon">${escapeHtml(favLetter(item.url))}</span><div><strong>${escapeHtml(siteName(item.url))}</strong><small>${escapeHtml(item.url)}</small></div>${showTime ? `<time>${displayTime(item.visitedAt)}</time>` : '<span class="open-arrow">↗</span>'}</div>`;
  }

  function bindCollectionRows(container) {
    container.querySelectorAll("[data-url]").forEach((row) => row.addEventListener("click", () => navigate(row.dataset.url)));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function saveCurrentPage() {
    if (!currentUrl) return;
    const exists = savedPages.some((item) => item.url === currentUrl);
    savedPages = exists
      ? savedPages.filter((item) => item.url !== currentUrl)
      : [{ url: currentUrl, savedAt: Date.now() }, ...savedPages];
    writeStorage(SAVED_KEY, savedPages);
    updateSavedButton();
    toastMessage(exists ? "Removed from saved pages" : "Page saved to this device");
  }

  function updateSavedButton() {
    const isSaved = savedPages.some((item) => item.url === currentUrl);
    $("#savePage").classList.toggle("saved", isSaved);
    $("#savePage").textContent = isSaved ? "★" : "☆";
  }

  function renderShortcuts() {
    const defaults = [
      { name: "Wikipedia", url: "https://www.wikipedia.org", icon: "W", className: "icon-wiki" },
      { name: "Reddit", url: "https://www.reddit.com", icon: "r", className: "icon-reddit" },
      { name: "Hacker News", url: "https://news.ycombinator.com", icon: "Y", className: "icon-hn" },
    ];
    $("#shortcutList").innerHTML = [...defaults, ...shortcuts].map((item) => `
      <button class="shortcut-item ${item.custom ? "custom-shortcut" : ""}" data-url="${escapeAttribute(item.url)}">
        <span class="shortcut-icon ${item.className || ""}">${escapeHtml(item.icon || favLetter(item.url))}</span>${escapeHtml(item.name)}
      </button>`).join("");
    $("#shortcutList").querySelectorAll("[data-url]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.url)));
  }

  async function checkHealth() {
    if (!PROXY_ORIGIN) {
      $("#connectionStatus").textContent = "Proxy URL not configured";
      $("#topStatusDot").className = "offline";
      $("#sidebarStatus").className = "status-dot offline";
      return;
    }
    try {
      const healthUrl = isLocal && window.location.protocol !== "file:"
        ? `${window.location.origin}/health`
        : `${PROXY_ORIGIN}/health`;
      const response = await fetch(healthUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("Proxy is unavailable");
      const config = await response.json();
      if (typeof config.proxy === "string") {
        const reportedOrigin = new URL(config.proxy);
        if (["http:", "https:"].includes(reportedOrigin.protocol)) {
          PROXY_ORIGIN = reportedOrigin.origin;
        }
      }
      $("#connectionStatus").textContent = "Proxy ready";
      $("#topStatusDot").className = "online";
      $("#sidebarStatus").className = "status-dot online";
    } catch {
      $("#connectionStatus").textContent = "Proxy unavailable";
      $("#topStatusDot").className = "offline";
      $("#sidebarStatus").className = "status-dot offline";
    }
  }

  $("#searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(addressInput.value);
  });
  $("#browserForm").addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(browserAddress.value);
  });
  $("#proxyFrame").addEventListener("load", () => {
    clearTimeout(loadingTimer);
    setTimeout(() => frameLoading.classList.add("hidden"), 180);
    updateSavedButton();
    renderRecent();
  });
  $("#proxyFrame").addEventListener("error", () => {
    clearTimeout(loadingTimer);
    frameLoading.classList.add("hidden");
    toastMessage("This page could not be loaded through the configured proxy.");
  });
  window.addEventListener("message", (event) => {
    if (event.source !== proxyFrame.contentWindow || event.data?.type !== "veil:navigate") return;
    let destination;
    try {
      destination = new URL(event.data.url);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(destination.protocol) || destination.href === currentUrl) return;
    currentUrl = destination.href;
    browserAddress.value = currentUrl;
    const pages = historyItems().filter((item) => item.url !== currentUrl);
    pages.unshift({ url: currentUrl, visitedAt: Date.now() });
    writeStorage(HISTORY_KEY, pages.slice(0, 60));
    updateSavedButton();
    renderRecent();
  });
  $("#backHome").addEventListener("click", () => showView("home"));
  $("#refreshPage").addEventListener("click", () => {
    if (currentUrl) {
      frameLoading.classList.remove("hidden");
      proxyFrame.src = proxyUrl(currentUrl);
    }
  });
  $("#savePage").addEventListener("click", saveCurrentPage);
  $("#expandPage").addEventListener("click", () => {
    if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
  });
  $("#newSession").addEventListener("click", () => {
    currentUrl = "";
    browserAddress.value = "";
    proxyFrame.src = "about:blank";
    addressInput.value = "";
    showView("home");
    addressInput.focus();
  });
  $("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#helpButton").addEventListener("click", () => $("#infoDialog").showModal());
  $("#privacyDetails").addEventListener("click", () => $("#infoDialog").showModal());
  $("#addShortcut").addEventListener("click", () => $("#shortcutDialog").showModal());
  $("#closeShortcut").addEventListener("click", () => $("#shortcutDialog").close());
  $("#cancelShortcut").addEventListener("click", () => $("#shortcutDialog").close());
  $("#shortcutForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#shortcutName").value.trim();
    const rawUrl = $("#shortcutUrl").value.trim();
    const url = formatAddress(rawUrl);
    if (!name || !url || !/^https?:\/\//i.test(url)) {
      toastMessage("Enter a valid website URL.");
      return;
    }
    shortcuts = [{ name, url, custom: true }, ...shortcuts.filter((item) => item.url !== url)].slice(0, 8);
    writeStorage(SHORTCUTS_KEY, shortcuts);
    renderShortcuts();
    $("#shortcutForm").reset();
    $("#shortcutDialog").close();
    toastMessage("Shortcut added");
  });
  $("#clearCollection").addEventListener("click", () => {
    const savedView = $("#collectionTitle").textContent === "Saved pages";
    if (savedView) {
      savedPages = [];
      writeStorage(SAVED_KEY, savedPages);
      renderCollection("saved");
      toastMessage("Saved pages cleared");
    } else {
      writeStorage(HISTORY_KEY, []);
      renderCollection("history");
      renderRecent();
      toastMessage("History cleared");
    }
  });
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$("[data-open-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.openView)));
  $$(".quick-card").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.url)));
  $$(".shortcut-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.url)));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showView("home");
      addressInput.focus();
    }
    if (event.key === "Escape") $("#sidebar").classList.remove("open");
  });

  renderShortcuts();
  renderRecent();
  checkHealth();
})();

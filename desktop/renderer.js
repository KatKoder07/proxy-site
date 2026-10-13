(() => {
  const addressInput = document.querySelector("#addressInput");
  const addressForm = document.querySelector("#addressForm");
  const browser = document.querySelector("#browser");
  const status = document.querySelector("#browserStatus");
  const welcome = document.querySelector("#welcome");
  const backButton = document.querySelector("#backButton");
  const forwardButton = document.querySelector("#forwardButton");
  let loadingTimer;

  function resolveAddress(value) {
    const input = value.trim();
    if (!input) return "";
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
      try {
        const url = new URL(input);
        return ["http:", "https:"].includes(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    }
    if (/^(?:localhost|(?:[\w-]+\.)+[\w-]{2,})(?::\d+)?(?:[/?#].*)?$/i.test(input)) {
      return `https://${input}`;
    }
    return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  }

  function updateNavigationButtons() {
    backButton.disabled = !browser.canGoBack();
    forwardButton.disabled = !browser.canGoForward();
  }

  function navigate(value) {
    const destination = resolveAddress(value);
    if (!destination) {
      status.textContent = "Enter an HTTP or HTTPS address";
      addressInput.focus();
      return;
    }
    addressInput.value = destination;
    welcome.hidden = true;
    status.textContent = "Connecting…";
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      if (status.textContent === "Connecting…") status.textContent = "Still loading…";
    }, 20_000);
    browser.loadURL(destination).catch((error) => {
      clearTimeout(loadingTimer);
      status.textContent = `Could not open page: ${error.message}`;
    });
  }

  addressForm.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(addressInput.value);
  });
  document.querySelector("#homeButton").addEventListener("click", (event) => {
    event.preventDefault();
    browser.loadURL("about:blank");
    addressInput.value = "";
    welcome.hidden = false;
    status.textContent = "Ready";
  });
  document.querySelector("#backButton").addEventListener("click", () => {
    if (browser.canGoBack()) browser.goBack();
  });
  document.querySelector("#forwardButton").addEventListener("click", () => {
    if (browser.canGoForward()) browser.goForward();
  });
  document.querySelector("#reloadButton").addEventListener("click", () => {
    if (browser.getURL() !== "about:blank") browser.reload();
  });

  browser.addEventListener("did-start-loading", () => {
    status.textContent = "Loading…";
    clearTimeout(loadingTimer);
  });
  browser.addEventListener("did-stop-loading", () => {
    clearTimeout(loadingTimer);
    status.textContent = "Ready";
    updateNavigationButtons();
  });
  browser.addEventListener("did-navigate", (event) => {
    addressInput.value = event.url === "about:blank" ? "" : event.url;
    updateNavigationButtons();
  });
  browser.addEventListener("did-navigate-in-page", (event) => {
    addressInput.value = event.url;
    updateNavigationButtons();
  });
  browser.addEventListener("page-title-updated", (event) => {
    if (event.title) document.title = `${event.title} — Veil`;
  });
  browser.addEventListener("did-fail-load", (event) => {
    if (event.errorCode === -3) return;
    clearTimeout(loadingTimer);
    status.textContent = `Page failed to load: ${event.errorDescription}`;
  });

  window.veilDesktop.onNavigate((url) => navigate(url));
  window.veilDesktop.onFocusAddress(() => {
    addressInput.focus();
    addressInput.select();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      addressInput.focus();
      addressInput.select();
    }
  });

  updateNavigationButtons();
})();

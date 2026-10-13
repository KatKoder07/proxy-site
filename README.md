# Veil Browser

A lightweight, self-hosted web browsing workspace with a local HTTP/HTTPS proxy.

## Run locally

Requires Node.js 20 or later. No package installation is needed.

```sh
npm start
```

Open `http://127.0.0.1:4173`. The app serves its interface on port 4173 and the local proxy on port 4174. Both listeners bind to loopback only; set `PORT` and `PROXY_PORT` to change the ports.

## Use the desktop browser for games and interactive sites

The GitHub Pages app uses a reverse proxy and cannot provide a full browser network stack. Use the separate Electron/Chromium app in `desktop` for sites that need browser cookies, WebSockets, WebRTC, or game streaming. It opens sites directly in Chromium and keeps their normal site cookies and storage in a persistent, isolated browser session; it does not send those sites through the hosted Render proxy.

Install Node.js 20 or later, then run:

```sh
cd desktop
npm install
npm start
```

To build a Windows installer instead, run `npm run dist:win` from `desktop`; the installer is written to `desktop/dist`. A GitHub Actions workflow also builds the installer on Windows after desktop changes; download the `veil-windows-installer` artifact from that workflow's run. The desktop app requires an internet connection and does not bypass network restrictions or guarantee that a site supports Electron.

## Deploy the interface to GitHub Pages

The GitHub Actions workflow in `.github/workflows/pages.yml` publishes the static files in `public` when changes are pushed to `main`. In the repository settings, enable Pages and select **GitHub Actions** as the build and deployment source.

GitHub Pages cannot run the Node.js proxy. Deploy the backend separately (the included `render.yaml` is a Render blueprint), then edit `public/config.js` and set `window.VEIL_PROXY_ORIGIN` to the backend's HTTPS origin, for example `https://your-proxy.onrender.com`. Commit and push that change to publish the configured interface.

In the backend host's environment settings, set `ALLOWED_ORIGINS` to the Pages origin, such as `https://your-user.github.io` (no trailing slash). Set `HOST` to `0.0.0.0` and `PROXY_ONLY` to `true`; the included Render blueprint sets these. The proxy uses the host-provided `PORT`, serves `/health` for health checks, and derives its public HTTPS origin from the host's forwarded headers. Set `PUBLIC_PROXY_ORIGIN` if the host does not provide correct `X-Forwarded-Proto` and `Host` headers.

**Public deployment warning:** an unauthenticated public proxy can be used by anyone who can reach its backend, not just visitors to your Pages site. CORS is not authentication, and the destination address checks do not prevent abuse of public websites or unexpected hosting charges. Add authentication, rate limits, and provider-level usage controls before making the backend generally accessible.

## What it does

- Opens HTTP and HTTPS pages in a sandboxed browser frame.
- Rewrites common links, images, stylesheets, and form destinations through the configured proxy.
- Offers URL entry, DuckDuckGo search, shortcuts, local history, and saved pages.
- Keeps history and saved pages in this browser's local storage.
- Rejects private/reserved IP destinations, credentials in URLs, and non-standard destination ports; pins validated DNS results when connecting.
- Supports HTTP byte-range requests for sites that serve seekable media.
- Limits requests to 1 MB, responses to 10 MB, redirects to five, and upstream time to 20 seconds.

## Limitations and privacy

This is a browsing convenience, not an anonymity service. Remote websites see the proxy server's public IP when using a hosted backend, or your device's public IP when running the proxy locally. The proxy operator can process the traffic; HTTPS is encrypted between the proxy and HTTPS destinations, while HTTP destinations are not encrypted. The app does not store proxy traffic, forward browser cookies, or forward authorization headers. Byte-range forwarding helps with some media, but this is not a streaming proxy and does not support WebSockets or WebRTC. Pages that depend on sign-in, cookies, complex client-side routing, service workers, pop-ups, or anti-embedding checks may not work. Use the browser toolbar's external-link button to open the original URL directly when a site is incompatible. Avoid entering sensitive information.

The proxy is bound to `127.0.0.1` by default. Do not expose it to the public internet without adding authentication, rate limits, stronger request isolation, and a deployment-specific security review.

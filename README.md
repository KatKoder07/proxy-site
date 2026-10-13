# Veil Browser

A lightweight, self-hosted web browsing workspace with a local HTTP/HTTPS proxy.

## Run locally

Requires Node.js 20 or later. No package installation is needed.

```sh
npm start
```

Open `http://127.0.0.1:4173`. The app serves its interface on port 4173 and the local proxy on port 4174. Both listeners bind to loopback only; set `PORT` and `PROXY_PORT` to change the ports.

## Deploy the interface to GitHub Pages

The GitHub Actions workflow in `.github/workflows/pages.yml` publishes the static files in `public` when changes are pushed to `main`. In the repository settings, enable Pages and select **GitHub Actions** as the build and deployment source.

GitHub Pages cannot run the Node.js proxy. Deploy the backend separately (the included `render.yaml` is a Render blueprint), then edit `public/config.js` and set `window.VEIL_PROXY_ORIGIN` to the backend's HTTPS origin, for example `https://your-proxy.onrender.com`. Commit and push that change to publish the configured interface.

In the backend host's environment settings, set `ALLOWED_ORIGINS` to the Pages origin, such as `https://your-user.github.io` (no trailing slash). Set `HOST` to `0.0.0.0` and `PROXY_ONLY` to `true`; the included Render blueprint sets these. The proxy uses the host-provided `PORT`, serves `/health` for health checks, and derives its public HTTPS origin from the host's forwarded headers. Set `PUBLIC_PROXY_ORIGIN` if the host does not provide correct `X-Forwarded-Proto` and `Host` headers.

**Public deployment warning:** an unauthenticated public proxy can be used by anyone who can reach its backend, not just visitors to your Pages site. CORS is not authentication, and the destination address checks do not prevent abuse of public websites or unexpected hosting charges. Add authentication, rate limits, and provider-level usage controls before making the backend generally accessible.

## What it does

- Opens HTTP and HTTPS pages in a sandboxed browser frame.
- Rewrites common links, images, stylesheets, and form destinations through the local proxy.
- Offers URL entry, DuckDuckGo search, shortcuts, local history, and saved pages.
- Keeps history and saved pages in this browser's local storage.
- Rejects private/reserved IP destinations, credentials in URLs, and non-standard destination ports; pins validated DNS results when connecting.
- Limits requests to 1 MB, responses to 10 MB, redirects to five, and upstream time to 20 seconds.

## Limitations and privacy

This is a local browsing convenience, not an anonymity service. The remote website can still see your public IP address. HTTPS remains encrypted between this device and the destination; HTTP destinations are not encrypted. The app does not store proxy traffic, forward browser cookies, or forward authorization headers. Pages that depend on sign-in, complex client-side routing, service workers, pop-ups, or anti-embedding checks may not work. Avoid entering sensitive information.

The proxy is bound to `127.0.0.1` by default. Do not expose it to the public internet without adding authentication, rate limits, stronger request isolation, and a deployment-specific security review.

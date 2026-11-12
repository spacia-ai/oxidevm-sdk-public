# Static deployment and previews

The frontend serves static assets. Linux commands execute in the user's browser;
the frontend server does not execute guest workloads or store their workspaces.

## Application host

Serve the production build over HTTPS, or a trustworthy loopback origin during
development. The application document, workers and relevant runtime responses
must retain these headers on successful, cached and error responses:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve `.wasm` as `application/wasm`, module workers as JavaScript and image JSON
as `application/json`. Prevent SPA fallback from returning HTML for missing
worker, Wasm, manifest and chunk URLs. Configure a restrictive CSP that permits
the application's module workers, Wasm compilation and intended asset origins.
Do not replace a missing isolation header with a browser security flag.

For Vite development, preserve the installed SDK's worker-relative URLs:

```ts
import { defineConfig } from "vite";
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  optimizeDeps: { exclude: ["@oxidevm/sdk"] },
  worker: { format: "es" },
  server: { headers },
  preview: { headers },
});
```

The production build must contain worker output as well as the main bundle.
Inspect network responses in an installed-package browser test. An import or
frontend build alone does not prove workers execute.

## Hosted runtime frame

`createVM({ ..., runtime: { hosting: "frame" } })` runs the whole runtime (workers,
engine WebAssembly, browser storage and images) in a hidden frame on Spacia's
runtime origin, `https://run.oxidevm.dev`, like the WebContainer API (ADR 0021
in the engine repository). The application then serves no engine files: it
needs only the SDK package and the two isolation headers above, because a frame
can be cross-origin isolated only inside an isolated page. Without them
`createVM` fails at once with `FEATURE_NOT_AVAILABLE`, naming the headers.

- The frame for SDK version `X` lives at `/v/X/`; the engine release it pins at
  `/engine/<release id>/` on the same origin. `runtime.origin` selects another
  origin serving the same layout.
- If the application has a CSP, allow `frame-src` for the runtime origin.
- Images and relays the page passes are fetched by the frame, from another
  origin than the page, so they need CORS (`Access-Control-Allow-Origin`) and
  `Cross-Origin-Resource-Policy: cross-origin`. Images must be supplied explicitly in this release.
- Relays see the frame's origin for every page that embeds it, so the frame names
  the page in the relay's workspace ID, `<page origin> <workspaceId>`, and sends a
  server relay's session request without cookies: authenticate that route with
  `headers` (see [the API reference](api.md#networking-and-previews)).
- Storage is partitioned by the top-level site: each application keeps its own
  workspaces and restore points in the frame.
- Previews: with Spacia's frame, `preview` defaults to
  `{ origin: "https://oxvm.dev", isolation: "per-session" }`, so exposed ports
  open on `https://<session>.oxvm.dev`. The keeper iframe of each preview lives in
  the application's page (the frame asks the page to open it, and the page opens
  only `/__oxidevm/` on its own preview origin), so the keeper and the iframe that
  shows the preview share one storage partition. Another runtime origin needs an
  explicit `preview`.
- `getDiagnostics` and raw machines (`@oxidevm/sdk/machine`) need a self-hosted
  runtime.
- The starter selects frame hosting in development and production. The starter uses the pinned hosted runtime at `run.oxidevm.dev`.
  Allow that origin in your application's `frame-src` policy.

The frame page itself is `assets/runtime-host/` in the SDK package. Whoever
serves it (Spacia's CDN, or a licensed self-hosted mirror) sends the headers in
its `headers.json` on every response: COOP `same-origin`, COEP `require-corp`,
CORP `cross-origin` and its CSP, which allows WebAssembly compilation and
`frame-ancestors *`.

## Immutable assets

Explicit self-hosting with `oxidevm assets install` stages the SDK's pinned engine release and the
selected authenticated image. The SDK package contains no engine: the release comes
from the verified CDN release, `--engine-dir <release>`, `OXIDEVM_ENGINE_DIR`,
or the local engine cache (`~/.cache/oxidevm/engine/<release id>`). Authenticated
custom release channels are also supported. Its `release.json` must hash to the pinned release ID, and
each module and the engine `LICENSE` must match their pinned size and SHA-256, before
all six files are staged, world-readable, under `runtime/`; the engine keeps its own
license terms. `oxidevm.lock.json` records versions, descriptor, digests,
author anchor and layout. Relocating `runtime.baseUrl` cannot change the expected
engine bytes: the browser verifies every module again before any worker runs it.
Keep retained image bases needed by persisted workspaces and restore points.
Publish a complete directory atomically; do not select partial downloads or
overwrite unrelated assets.

Guest artifacts are separate distributions with their own license and source
obligations. They are not embedded in npm packages. The starter loads a signed
image from the CDN. Its corresponding sources and notices are available through
the links in the [licensing guide](licensing.md). Custom images require explicit
author trust and verified references.

### WebAssembly modules

Modules are separate from the engine and the image. `oxidevm wasm add` writes the
declaration and lock to commit, and stages each module's files under
`.oxidevm/modules/<id>/<release>/`; `oxidevm wasm stage` rebuilds them after a
clone, so run it before the production build. The generated handles name those
files with `new URL(path, import.meta.url)`, so bundlers copy them as assets (small
files may be inlined as `data:` URLs; both forms are verified against the lock).
Ship the notices a module's license requires, and the source offer for a copyleft
module, with the application. Modules start JS processes of a Userspace VM, on a
cross-origin isolated page, with a self-hosted runtime or the hosted runtime
frame. See [WebAssembly modules](wasm-modules.md).

Module code runs in a per-VM **module frame** with an opaque origin, never in the
application's origin (engine ADR 0028). The frame's document comes from the
origin that runs the runtime:

- **Hosted runtime frame:** `/v/<sdk version>/module-frame/` on the runtime
  origin, served by the runtime frame deployment with the frame's own headers.
  The page still reads the module's staged files from its own origin.
- **Self-hosted:** `oxidevm assets install` stages the SDK's module frame
  (`index.html`, `broker.js`, `runner.js` and the `frame.json` that holds its
  headers) at `module-frame/` beside the engine assets, that is
  `<runtime.baseUrl>module-frame/`. With the default `assetBaseUrl` that is
  `public/oxidevm/runtime/module-frame/`, served at
  `/oxidevm/runtime/module-frame/`. Run `oxidevm assets install` again after
  every SDK upgrade, as for the engine: the broker and runner speak that SDK's
  protocol versions, and the frame's policy names its bootstrap script by
  sha256. A deployment that does not use `assets install` serves the SDK
  package's `assets/module-frame/` directory there instead.

Every response under `module-frame/` carries the headers in that directory's
`frame.json` (`headers`), and not the application's own policy:

```http
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-<bootstrap>' blob: 'wasm-unsafe-eval' 'unsafe-eval'; worker-src blob:; connect-src blob:; frame-ancestors *; base-uri 'none'; form-action 'none'
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Copy the exact values from `frame.json` rather than from this page. The policy
must be a header, never a `<meta>` element: only the header carries `sandbox`,
which keeps the document opaque even when it is opened directly. CORP must be
`cross-origin`, because Firefox checks it against the frame's opaque origin. Do
not let a Service Worker answer `module-frame/` requests, and serve
`index.html` as `text/html` and the two scripts as JavaScript. A frame that does
not load fails with `FEATURE_NOT_AVAILABLE` `wasm-module-isolation-unavailable`
(`capability: "frame-load"`); a missing `broker.js` or `runner.js` fails with
`CORE_LOAD_FAILED` `module-frame-asset`. A frame served without its
`Content-Security-Policy` (a development middleware that serves `module-frame/`
like any other asset, say) refuses modules with `capability: "frame-policy"`:
the frame checks at startup that a fetch of a `data:` URL is refused, and a
runner that `importScripts` of one is, so a deployment that drops the policy
fails closed instead of handing module code the browser's network.

Under the application's own content security policy, allow `frame-src` for the
origin that serves the module frame (`'self'` when self-hosted), and
`connect-src 'self'` for the staged files and the frame's scripts, plus `data:`
when files are inlined. The runner imports the verified adapter from a `blob:`
URL inside the module frame, under the frame's policy. Modules run in Chromium and
Firefox; WebKit and Safari refuse them with a typed error.

## Preview host

Copy the SDK's packaged preview assets to a distinct host. `index.html`,
`bootstrap.js`, `sw.js`, `websocket.js` and `location.js` form one versioned
transport. The packaged `headers.json` is the authoritative hosting header
contract. The Service Worker and the other classic scripts must remain complete
classic scripts, not modules with unresolved imports.

Reserve `/__oxidevm/` for the transport files and permit the Service Worker scope
with `Service-Worker-Allowed: /`. For other paths, the admitted guest route owns
the HTTP response. A missing transport file must return 404. Keep preview assets
outside the application's Service Worker and application-storage scope.

Production needs DNS and TLS for a unique session host, such as
`<session>.preview.example.com`, including correct wildcard-host routing.
Configure the VM with the preview origin and `isolation: "per-session"`.
Transport authentication also checks session identity, expected message source
and origin; wildcard DNS by itself is not authorization.

A development-only shared preview origin can use
`{ origin, isolation: "shared", developmentOnly: true }`. This configuration does
not establish cookie/storage separation between independent production sessions.
Loopback preview URLs printed by tests are not externally accessible application
links.

Update the preview assets together with the SDK, or before it. One preview host
serves every SDK version, and newer preview assets accept every older SDK
unchanged, so deploying them first is safe. Site access
([API reference](api.md#preview-site-access)) needs this release's preview
assets: an SDK that asks an older preview host for any access other than
`{ kind: "none" }` rejects after 10 s with `FEATURE_NOT_AVAILABLE` and
`detail.reason: "preview-host-outdated"`. `{ kind: "none" }` sends nothing and
works with every preview host.

These assets also give every SDK version's previews the same default at once: a
preview page reaches only its session origin (`connect-src 'self'`). Some ways a
page can reach another site are outside the policy, such as navigation (links,
form submissions — there is no `form-action` directive — and `window.open`),
WebRTC and DNS prefetch hints. Earlier assets let sockets from a preview page
reach any host (`connect-src 'self' ws: wss:`). A page that relied on that
reaches the other host again once its application grants the site with an SDK
that has site access.

## Relay and validation

Guest-local sockets are the default. Outbound guest internet requires an explicit
relay connection through `vm.network` (or creation's `network: { mode: "relay",
connection }`), reviewed destination policy and actual transport. A server relay
needs your authenticated session route; the relay URL alone grants no access. A
successful host download of an image does not enable guest networking. Production
preview and relay sessions must be independently scoped and retired on VM disposal.

Run `oxidevm doctor <actual-application-url> --browser chromium --json` against
the deployed site. It checks served responses and browser execution rather than
inferring success from local configuration. Preserve its one structured report,
exact asset descriptor and browser version. Then exercise commands, persistence,
HTTP, websocket updates and separate sessions through the production host.

The report's `hosting` names the runtime the doctor checked. An application
that serves the SDK's doctor probe at its asset base (`<meta name="oxidevm-assets">`
or `/oxidevm/`) is checked as self-hosted: the headers, MIME types, bytes,
workers, Content-Security-Policy and storage of its own runtime assets. Any
other application can run only the hosted runtime frame, so the doctor checks
that instead: the page's secure context, cross-origin isolation and browser
features; whether this SDK release's frame at
`https://run.oxidevm.dev/v/<sdk-version>/` is served, is admitted by the page's
Content-Security-Policy and accepts the page; and whether the frame's engine
files match the SDK's pins and are served as `application/wasm`. Workers and
storage run inside the frame, so `worker-load` and `storage` are
`not-applicable` there. `--hosting frame` or `--hosting self-hosted` chooses
the runtime explicitly, and `--frame-origin` checks another frame origin, such
as a private qualification frame.

## Starter runtime selection

The starter uses `runtime: { hosting: "frame" }` in development and production.
Normal `oxidevm init` installs dependencies and writes pinned image references.
It does not download or stage engine files, image archives, or compliance files
on the developer's filesystem. The browser loads the SDK version's frame from
`https://run.oxidevm.dev/v/<sdk-version>/`. That frame verifies and executes the
engine in browser workers. Hosted per-session previews work in both builds.

`src/runtime.ts` owns the application's runtime selection. Explicit commercial
self-hosting remains available. `init --engine-dir <release>` stages the
selected pinned engine for local development. Its generated production setting
still uses the hosted frame. Configure licensed production self-hosting
explicitly under your commercial agreement. A locally supplied image can be
staged with `--image` and `--image-trust` while keeping engine execution hosted.
The pinned hosted runtime must exist before the default starter can run.
There is no automatic fallback to a local engine.

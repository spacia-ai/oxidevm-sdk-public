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

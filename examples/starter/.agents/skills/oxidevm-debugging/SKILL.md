---
name: oxidevm-debugging
description: Diagnose an OxideVM application's startup, hosted runtime iframe, guest process, upload, storage, network or preview failures using the public SDK and browser evidence.
license: Apache-2.0
---

# Diagnose an OxideVM application

Start with the exact action, error code and installed SDK version. Read the existing integration before changing it. Distinguish host JavaScript errors, runtime-frame startup errors, guest process exits and Python errors; they have different owners.

## Startup and delivery

For a runtime-frame timeout, inspect the actual request URL and HTTP status, browser console, `crossOriginIsolated`, COOP/COEP headers and `frame-src` policy. Check whether the application and runtime versions match. A missing versioned runtime URL requires the matching published runtime; it is not evidence that Linux execution became slower.

Preserve the hosted iframe in ordinary development. Do not fix a delivery error by downloading a proprietary engine, disabling image verification, removing browser isolation or changing the execution mode.

For an image failure, retain the exact manifest reference, digest and independent author trust. Distinguish download, signature and content-hash errors. Never accept a tampered image or replace its pin with whatever downloaded successfully.

## Workload and state

- Reproduce the exact guest command and check its exit or signal, stdout and stderr. A package-manager script command and a command with the same words but different arguments can run different programs.
- Separate first startup and import costs from repeated execution. Reuse the existing long-lived Python session before considering changes to Linux execution.
- Inspect the current upload and dataset generation when the displayed result appears stale. Preserve bounded decoding and previous-result/error handling.
- For storage failures, record the SDK's typed error and browser storage state. Do not erase workspaces, switch to in-memory storage or claim persistence without the user's intent and a verified result.
- For network and preview failures, inspect the existing permission flow, transport and isolated preview origin. Do not substitute a backend that executes or stores the workspace.

Use diagnostics exposed by the installed public SDK only when needed. Redact credentials and unrelated guest data. Changes to SDK internals or the proprietary engine require their owning repository and permission; this skill supplies consumer integration guidance.

Make the smallest fix at the owning boundary. Recheck the original action and one relevant failure case. State what passed and what remains unverified. See [OxideVM guides](https://oxidevm.dev/docs/) for supported configuration.

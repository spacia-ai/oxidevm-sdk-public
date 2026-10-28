# BlueOak 1.0.0 dependency policy review

> Copied on 2026-10-08 from the engine repository's
> `docs/dependencies/blueoak-1.0.0-review.md`, so that this repository carries its
> own record for `config/allowed-licenses.json`. The review below is the engine
> repository's text, unchanged, and keeps its 2026-10-06 review date. Read it from
> the engine's side: "the companion SDK" is this repository, and ADR 0019 is the
> engine repository's `docs/adr/0019-proprietary-engine-and-apache-sdk.md`. The
> first-party license of this repository is Apache-2.0 (Spacia B.V.).

Technical review date: 2026-10-06. Scope: the standalone SDK's Node image
authoring dependency graph, now included by the installed SDK archive.

The [SPDX record](https://spdx.org/licenses/BlueOak-1.0.0.json) identifies
BlueOak-1.0.0 as OSI approved and not deprecated. The installed upstream
license texts were read in full; their BlueOak bodies match the SPDX text
after Markdown/whitespace normalization. The
[official license](https://blueoakcouncil.org/license/1.0.0) is the notice link.

The Copyright section grants permission for every action otherwise requiring
a contributor's copyright permission. The Patent section supplies an explicit
patent grant. Notices requires the license text or its official link when any
part is passed on, including changed copies. It imposes no reciprocal source
release, same-license requirement, field-of-use limit or royalty. Reliability
prohibits revocation, and No Liability disclaims warranties and liability.
These properties meet the repository's permissive-platform policy and its
provision for explicitly reviewed equivalents. `config/allowed-licenses.json`
therefore includes this exact SPDX identifier.

| Upstream package | Pinned version | Installed LICENSE.md SHA-256 |
| --- | --- | --- |
| tar | 7.5.22 | `8a1af140fdfbf5afd3df27f7e662f989c5b963a300020dfafce42033cae9e004` |
| chownr | 3.0.0 | `a49c9ba464796f65b59fca3f1e6ca40912df1e859f575383223f7ec6c5baae09` |
| minipass | 7.1.3 | `8a1af140fdfbf5afd3df27f7e662f989c5b963a300020dfafce42033cae9e004` |
| yallist | 5.0.0 | `a49c9ba464796f65b59fca3f1e6ca40912df1e859f575383223f7ec6c5baae09` |

Chownr and yallist prefix their license with a rule directing packages under
`src/` to their own licenses. Neither installed npm artifact has a `src/`
directory; the remaining package has the stated BlueOak body. Preserve that
preamble when retaining their notices.

The SDK's compiled Node image-builder imports these upstream packages as
external dependencies; their own license files remain in the installed
packages. Preserve those notices in any future bundling or vendoring. The
regenerated CycloneDX SBOM reports their actual SPDX expression. The first-party
license declaration (ADR 0019) does not relicense third-party code.

This is a technical dependency-policy review performed as part of the
authorized implementation. It records no human operator session or default
Linux/Alpine/Node/Bun artifact rights approval. Those separate distribution
and release gates remain open in the companion SDK's qualification ledger.

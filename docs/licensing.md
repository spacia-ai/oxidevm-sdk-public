# SDK, engine, and image licenses

| Component | Terms |
| --- | --- |
| SDK, CLI, and starter application code | Apache-2.0 |
| OxideVM engine | Proprietary. Free non-commercial use and local development. Paid commercial production use. |
| Guest programs and libraries | Each program's original license |
| Fonts and other assets | Their original licenses and notices |

The SDK's Apache-2.0 license permits commercial use. Keep its license and
required notices when you redistribute it. Modified files must retain the
required change notices. Bundled dependency notices accompany both packages.
See [Apache's redistribution terms](https://www.apache.org/licenses/LICENSE-2.0).

## Engine use and deployment

The engine is a separate download. Local development also permits work on
commercial projects. Commercial production requires a Spacia commercial
agreement. Non-commercial hosted deployments use the existing registered
public-license process. A token records technical admission. It does not
expand the agreement's rights.

The starter uses the hosted runtime in local development and production.
Normal scaffolding installs no engine files in the project. The browser loads
and verifies the engine through the runtime iframe. It does not copy engine
binaries into your deployment. Licensed self-hosting requires an explicit
configuration and the rights granted by your agreement. See
[deployment](deployment.md) for the existing runtime options.

The verified cache retains `RUNTIME-LICENSE.txt`, `THIRD_PARTY_NOTICES.txt`,
`sbom.cdx.json`, and `license-policy.json` under a separate immutable compliance
revision. Check the runtime license supplied with your release. Hosted-runtime
service terms and privacy notices also apply. The existing hosted service
describes its boot telemetry at [run.oxidevm.dev/telemetry](https://run.oxidevm.dev/telemetry).

## Image use and redistribution

The nginx image is a collection of separately licensed programs. It includes
nginx, Toybox, dash, mksh, musl, PCRE2, OpenSSL and zlib.
It contains no OxideVM engine or Linux kernel. Engine restrictions do not
restrict rights granted by guest or dependency licenses.

Image materials include `OPEN-SOURCE-NOTICE.md`, SPDX and CycloneDX inventories,
license texts, copyright notices, checksums, and corresponding sources.
Retain those materials with redistributed image binaries. Toybox uses 0BSD.
The interactive mksh shell uses MirOS AND Unicode-DFS-2016. The scripting
dash shell uses BSD-3-Clause AND Apache-2.0 with an independently authored signal
table. Its GPL signal generator and generated output are excluded from the
runtime build. The source kit retains the original upstream terms. Their source archives,
original notices, configuration and build inputs accompany the image.
The starter contains no BusyBox, Bun or pnpm.

The default Playground image uses Node.js and npm. The homepage uses that same
image. The documentation server uses its own Python image with the same
Toybox/dash/mksh utilities. Other components retain their original licenses.
Selecting npm or Bun on your development computer does not change the tools
inside the guest image. Custom images can include other runtimes, subject to
their own license and redistribution obligations.

You can modify guest programs and build and sign your own images. An image
signature authenticates bytes. It does not remove the rights granted by
their licenses. You must meet their obligations when redistributing binaries.

The starter's Archivo, Roboto, and JetBrains Mono fonts use OFL-1.1.
Their original license files remain in `public/fonts`. Preserve them when
you redistribute the fonts. You may replace the fonts in your own app.

## Image source downloads

Image **oxidevm-starter-nginx 0.0.7**, manifest SHA-256 `08a15caaff78f2da43d2cc3d8a4f2443e0158967538236c52368bdf65b71cf97`.

These downloads are supplied under each component's original license.
They require no account or commercial engine license. The image bundle also
contains its corresponding source archives. Published source kits are retained
permanently under the release policy.

- [Open-source notice and component index](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/OPEN-SOURCE-NOTICE.md)
- [Complete license and copyright notices](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/NOTICES.txt)
- [Checksums](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SHA256SUMS)
- [SPDX inventory](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/sbom.spdx.json) and [CycloneDX SBOM](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/sbom.cdx.json)
- [Complete source and license bundle](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/sources-and-licenses.tar.gz)
- [Image source release](https://github.com/spacia-ai/oxidevm-sdk-public/releases/tag/image-oxidevm-starter-nginx-v0.0.7)

| Component | License | Downloads | Source archive SHA-256 |
| --- | --- | --- | --- |
| toybox 0.8.15 | 0BSD | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-toybox.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-toybox.BUILD.md) | `de33c119672310ba2de69d82dbd998779e306b7375a08bd97849585c9a25e2d3` |
| dash 0.5.13.5 | BSD-3-Clause AND Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dash.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dash.BUILD.md) | `e2a7dd1ea5f76fb032ca36681f16cbe3d0354133b88d0aa63f43d60151b466f2` |
| mksh 59c-r4 | MirOS AND Unicode-DFS-2016 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-mksh.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-mksh.BUILD.md) | `da3facdf7876b508ae758e94b9fead639c5d0491bb37a3b5890eb77b075c3025` |
| nginx 1.30.6-r0 | BSD-2-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-nginx.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-nginx.BUILD.md) | `a3ab7ccd36a80332dc2a371d720c542aef3b59ec094750af6587a8d7295944a9` |
| musl 1.2.6-r2 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-musl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-musl.BUILD.md) | `5b4aaefb3dcdcc4106154f0b6ff6ea26142bea2318ebccb5317f8414ca50faa9` |
| pcre2 10.49-r0 | BSD-3-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-pcre2.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-pcre2.BUILD.md) | `4eec11ff3f89bcaeb06f7f1198cd1ea2bd4017058ece00e36e00708c8b1a653c` |
| openssl 3.5.7-r0 | Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-openssl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-openssl.BUILD.md) | `08ee53f72680ec7917deb434b39dd0d62f72ffa0556a1c7fe1d04cb0d2b2b929` |
| zlib 1.3.2-r0 | Zlib | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-zlib.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-zlib.BUILD.md) | `4bd8c934299aaf165e9f84b77363f392d1f41abd3c981046c1ececf8e77fc83a` |
| oxidevm-starter-files 0.0.1 | Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-oxidevm-starter-files.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-oxidevm-starter-files.BUILD.md) | `95c75b4ca7848b8463239f0a45eae61628826c739df7da90ab61b84b90a203e7` |
| xz 5.8.4 | 0BSD | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-xz.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-xz.BUILD.md) | `6d1a802eb008eaeda1f8148671c6ba4ec39349189763460e1d62eb1714a77a85` |
| libarchive 3.8.10 | BSD-2-Clause AND BSD-3-Clause AND CC0-1.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libarchive.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libarchive.BUILD.md) | `5595fe3313b314e291da627a2b1d339ef9703baec7fd90b39172e2e2abeff3bd` |
| dc 7.0.3 | BSD-2-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dc.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dc.BUILD.md) | `390977a43b74fbc0d3407a510b406db843880f5021aaf725d4a8409a687518c2` |
| dropbear 2026.94 | MIT AND BSD-2-Clause AND SSH-short | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dropbear.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-dropbear.BUILD.md) | `3f8f2eb0634e65726bcb67b0d1e308018cefc01ba8909a727fb68ccd49d038cd` |
| libtomcrypt dropbear-2026.94 | WTFPL | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libtomcrypt.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libtomcrypt.BUILD.md) | `f28e8fa028dcc96e4f77c046622f2d1e916167fcd6f988943ee66081b0bde1d9` |
| libtommath dropbear-2026.94 | Unlicense | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libtommath.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-libtommath.BUILD.md) | `64eb59c6084c8a26908f639b97f1a6ca5d69ee27281a52bd38be9a8374456325` |
| curl 8.23.0 | curl | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-curl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-curl.BUILD.md) | `a875f2dab2669e19a87c5259b8fef04fdd62db31846eba653201b19fac578ff2` |
| ca-certificates 20260611-r0 | MPL-2.0 AND MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-ca-certificates.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-ca-certificates.BUILD.md) | `47160bc635531bad50181f71f74a49efcd0f57342eac93a78a8f37dad6ef1296` |
| gcc-runtime 15.2.0-r5 | GPL-3.0-or-later WITH GCC-exception-3.1 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-gcc-runtime.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-gcc-runtime.BUILD.md) | `5385a0c64d2315e640c2cf18b0371b354b78c79651ba174961471797df21e582` |
| musl-crt 1.2.6-r3 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-musl-crt.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-nginx-v0.0.7/SPDXRef-Package-musl-crt.BUILD.md) | `302c0b882fc023dbf349ea00293b5275593303356b690e013c3ee7f29da93098` |

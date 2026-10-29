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

The Python + pandas image is a collection of separately licensed programs. It includes
Python, NumPy, pandas, Toybox, dash, mksh, musl, OpenSSL and their required libraries.
NumPy and pandas compile from their pinned sources. NumPy uses its internal
BLAS/LAPACK fallback. The default image excludes libquadmath, libgfortran and
OpenBLAS. GCC runtime libraries retain their explicit Runtime Library Exception.
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

Image **oxidevm-starter-pandas 0.0.1**, manifest SHA-256 `7d0be40c82e63a3d50bc045f1442adcfefcb8b7d141815127845f7b3bd0a4e58`.

These downloads are supplied under each component's original license.
They require no account or commercial engine license. The image bundle also
contains its corresponding source archives. Published source kits are retained
permanently under the release policy.

- [Open-source notice and component index](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/OPEN-SOURCE-NOTICE.md)
- [Complete license and copyright notices](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/NOTICES.txt)
- [Checksums](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SHA256SUMS)
- [SPDX inventory](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/sbom.spdx.json) and [CycloneDX SBOM](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/sbom.cdx.json)
- [Complete source and license bundle](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/sources-and-licenses.tar.gz)
- [Image source release](https://github.com/spacia-ai/oxidevm-sdk-public/releases/tag/image-oxidevm-starter-pandas-v0.0.1)

| Component | License | Downloads | Source archive SHA-256 |
| --- | --- | --- | --- |
| bzip2 1.0.8-r6 | bzip2-1.0.6 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `5e82fee5cfcd1a6e7df9c51b65d40d2c363830ac5dd9730d5f83839698139b3b` |
| ca-certificates 20260611-r0 | MPL-2.0 AND MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-ca-certificates.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `47160bc635531bad50181f71f74a49efcd0f57342eac93a78a8f37dad6ef1296` |
| curl 8.23.0 | curl | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-curl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `a875f2dab2669e19a87c5259b8fef04fdd62db31846eba653201b19fac578ff2` |
| dash 0.5.13.5 | BSD-3-Clause AND Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-dash.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `e2a7dd1ea5f76fb032ca36681f16cbe3d0354133b88d0aa63f43d60151b466f2` |
| dc 7.0.3 | BSD-2-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-dc.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `390977a43b74fbc0d3407a510b406db843880f5021aaf725d4a8409a687518c2` |
| dropbear 2026.94 | MIT AND BSD-2-Clause AND SSH-short | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-dropbear.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `3f8f2eb0634e65726bcb67b0d1e308018cefc01ba8909a727fb68ccd49d038cd` |
| expat 2.9.0-r0 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-expat.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `0c6f3ebcf78028f540f68e8aec6c8b3568dba0c4e0610078e4b455e1e711cdaa` |
| gcc-runtime 15.2.0-r5 | GPL-3.0-or-later WITH GCC-exception-3.1 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-gcc-runtime.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `5385a0c64d2315e640c2cf18b0371b354b78c79651ba174961471797df21e582` |
| libarchive 3.8.10 | BSD-2-Clause AND BSD-3-Clause AND CC0-1.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-libarchive.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `5595fe3313b314e291da627a2b1d339ef9703baec7fd90b39172e2e2abeff3bd` |
| libffi 3.5.2-r0 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-libffi.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `618a71dd4be71ac32e7cb67d0bf10f47902e3ad1ee200154ffe0a578c2c6c54f` |
| libtomcrypt dropbear-2026.94 | WTFPL | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-libtomcrypt.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `f28e8fa028dcc96e4f77c046622f2d1e916167fcd6f988943ee66081b0bde1d9` |
| libtommath dropbear-2026.94 | Unlicense | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-libtommath.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `64eb59c6084c8a26908f639b97f1a6ca5d69ee27281a52bd38be9a8374456325` |
| mksh 59c-r4 | MirOS AND Unicode-DFS-2016 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-mksh.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `da3facdf7876b508ae758e94b9fead639c5d0491bb37a3b5890eb77b075c3025` |
| mpdecimal 4.0.1-r0 | BSD-2-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-mpdecimal.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `06f196d00fda2de88a8d7c5f825e6a106726b73772dffebf77242c764e721cb1` |
| musl 1.2.6-r2 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-musl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `5b4aaefb3dcdcc4106154f0b6ff6ea26142bea2318ebccb5317f8414ca50faa9` |
| musl-crt 1.2.6-r3 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-musl-crt.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `302c0b882fc023dbf349ea00293b5275593303356b690e013c3ee7f29da93098` |
| ncurses 6.5_p20251123-r0 | X11 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-ncurses.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `f6d9a3d592fc111fb4643da2f57e27c554a9e3798fc9d63d082071c14ce47dd5` |
| numpy 2.2.6 | BSD-3-Clause AND MIT AND Zlib | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-numpy.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `8bb0b836dba6f9fd987ebfaa008153bf1c922ed2af058d2d2827eae055e63ef1` |
| openssl 3.5.7-r0 | Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-openssl.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `08ee53f72680ec7917deb434b39dd0d62f72ffa0556a1c7fe1d04cb0d2b2b929` |
| oxidevm-default-profile 1.0.6 | Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-oxidevm-default-profile.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `d1f17979d5903f7754bfac8e707440c60c9b10dbafdce0e17ca02d299efbaeae` |
| pandas 2.3.3 | BSD-3-Clause AND BSD-2-Clause AND MIT AND Apache-2.0 AND PSF-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-pandas.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `0ba36c90c543601ee29abad609975830f527df4616c735be4be732cf1318f13d` |
| python-dateutil 2.9.0.post0 | BSD-3-Clause | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-python-dateutil.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `3df3b80cfc9f35894934b11541bc3d39b7b9876e877551b9575fcd9393bd286e` |
| python3 3.12.15-r0 | PSF-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-python3.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `5d67fa5f4e1f7103750e10340aaa1f2047013445d981a74095509b2f963f9ebb` |
| pytz 2025.2 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-pytz.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `eaa2e381baf2f0e5d5bdb14bb6f8a986fbbd9f3c89b80c7df888ebfe5ccbe59f` |
| six 1.17.0 | MIT | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-six.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `d37eaf57f6b102dd343e80974c205a248d0ea0b8a4fe19f3c0361a0600170d4f` |
| sqlite 3.53.4-r0 | blessing | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-sqlite.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `937392c4ad89334afc940cef6ca8974a503d4154f10d01d198d6aa0d332999b5` |
| toybox 0.8.15 | 0BSD | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-toybox.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `de33c119672310ba2de69d82dbd998779e306b7375a08bd97849585c9a25e2d3` |
| tzdata 2025.2 | Apache-2.0 | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-tzdata.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `c958c50a567dbd95323766dcbebb483bceb88f6568b68169e52bbb2054c63666` |
| xz 5.8.4 | 0BSD | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-xz.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `6d1a802eb008eaeda1f8148671c6ba4ec39349189763460e1d62eb1714a77a85` |
| zlib 1.3.1-r2 | Zlib | [Source archive](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-zlib.tar.gz) · [Build instructions](https://github.com/spacia-ai/oxidevm-sdk-public/releases/download/image-oxidevm-starter-pandas-v0.0.1/SPDXRef-Package-bzip2.BUILD.md) | `85b521d0f4580535b4c61f3aaa774e6358026f96c1fca9407fb21d63d3c50ac4` |

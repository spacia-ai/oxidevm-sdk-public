# Source-built Python package terms

These selections apply to the exact sources pinned in `python-inputs.lock.json`.
Keep complete original notices, including their copyright holders. The generated
source kits retain the full upstream archives and all build inputs.

| Shipped source | Runtime terms and nested code |
| --- | --- |
| NumPy 2.2.6 | BSD-3-Clause; lapack-lite BSD-3-Clause; dragon4 MIT; libdivide Zlib |
| pandas 2.3.3 | BSD-3-Clause; retain BSD-2-Clause, MIT, Apache-2.0 and PSF-2.0 notices for bundled code |
| python-dateutil 2.9.0.post0 | Select BSD-3-Clause. Its original license states that this branch covers all code, including dual-licensed code |
| pytz 2025.2 | MIT |
| tzdata 2025.2 | Apache-2.0 package terms; retain original IANA data notices and provenance |
| six 1.17.0 | MIT |

For pandas' vendored packaging code, select Apache-2.0 from its dual license.
Keep its original dual-license text. Other bundled notices include Bottleneck,
NumPy, dateutil, klib, musl, Python, pyperclip, ReadStat/Haven, SAS7BDAT,
ultrajson and xarray. The combined expression preserves the selected obligations.

NumPy's vendored Meson and other build-only tools do not run in the image.
Their original source and licenses remain in the source kit. Do not label these
build-only terms as a grant for the delivered runtime. The source-built wheels
use no external BLAS, libgfortran or libquadmath. GCC runtime libraries and
startup objects retain their explicit GCC Runtime Library Exception or MIT terms.

These records support technical review. They do not record legal approval for
this changed image. A prior nginx approval does not approve these new artifacts.

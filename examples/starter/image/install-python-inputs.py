"""Extract only pinned Python headers, Ninja, and the GCC runtime closure."""
from pathlib import Path
import tarfile

for name in ("python3-3.12.15-r0.apk", "python3-dev-3.12.15-r0.apk", "ninja-build-1.13.2-r1.apk", "libgcc-15.2.0-r5.apk", "libstdc++-15.2.0-r5.apk"):
    with tarfile.open(Path("/python-inputs") / name, ignore_zeros=True) as archive:
        for member in archive:
            if member.name.startswith(("usr/include/python3.12/", "usr/lib/python3.12/config-", "usr/lib/ninja-build/", "usr/lib/libstdc++", "usr/lib/libgcc_s")):
                archive.extract(member, "/", filter="data")

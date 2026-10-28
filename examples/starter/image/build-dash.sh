#!/bin/sh
set -eu
export LC_ALL=C SOURCE_DATE_EPOCH=1792886400
mkdir -p /out /src
mkdir -p /src/dash
cd /src/dash
tar -xzf /inputs/dash-0.5.13.5.tar.gz --strip-components=1
# Exclude both the GPL generator and any pre-generated output before configuration.
rm -f src/mksignames.c src/signames.c
cat > signal-abi.c <<'C'
#include <signal.h>
int main(void) { return !(NSIG == 65 && SIGRTMIN == 35 && SIGRTMAX == 64); }
C
cc signal-abi.c -o signal-abi
./signal-abi
cp /dash-signames.c src/oxidevm-signames.c
for file in src/Makefile.am src/Makefile.in; do
  awk '
    /^HELPERS =/ {sub(/ mksignames/, "")}
    /^signames.c: mksignames$/ {print "signames.c: oxidevm-signames.c"; getline; print "\t$(AM_V_GEN)cp $(srcdir)/oxidevm-signames.c $@"; next}
    {print}
  ' "$file" > "$file.next"
  mv "$file.next" "$file"
  grep -q '^signames.c: oxidevm-signames.c$' "$file"
done
touch src/Makefile.in
./configure --disable-dependency-tracking --without-libedit CFLAGS='-O2 -ffile-prefix-map=/src/dash=dash' LDFLAGS='-Wl,--build-id=none -Wl,-Map,/out/dash-link.map'
make -j2
mkdir -p /out/dash
cp src/dash /out/dash/sh
cp src/signames.c /out/dash/signames.c
cp config.h /out/dash/config.h
./config.status --config > /out/dash/configure.args
cp COPYING /out/dash/UPSTREAM-COPYING
# Retain every runtime header notice, including generated BSD parser inputs.
find src -type f \( -name "*.c" -o -name "*.h" \) | sort | while IFS= read -r file; do
  if grep -Eq "GNU General Public License|GNU Lesser General Public License" "$file"; then
    printf 'Unreviewed dash runtime source: %s\n' "$file" >&2
    exit 1
  fi
  printf "\n===== %s =====\n" "$file"
  sed -n '1,/\*\//p' "$file"
done > /out/dash/runtime-notices.txt
cp /out/dash-link.map /out/dash/link.map
if grep -q mksignames /out/dash/link.map; then exit 1; fi
find src -type f \( -name "*.c" -o -name "*.h" \) | sort | xargs sha256sum > /out/dash/source-checksums.txt
test ! -e src/mksignames.c
test ! -e src/mksignames
cmp src/signames.c /dash-signames.c
./src/dash -ec 'test "$(kill -l 2)" = INT; trap "echo trap-ok" USR1; kill -USR1 $$; test $((2 + 3 * 7)) = 23'
readelf -d src/dash > /out/dash/libraries.txt

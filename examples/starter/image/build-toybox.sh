#!/bin/sh
set -eu
export LC_ALL=C SOURCE_DATE_EPOCH=1792886400 KCONFIG_NOTIMESTAMP=1
cd /src/toybox
make defconfig
# Terminal clients require the pending stty applet for native termios and resize checks.
for applet in STTY AWK TR EXPR BC CROND CRONTAB GETTY LAST GZIP DIFF VI; do
  sed -i "s/^# CONFIG_$applet is not set/CONFIG_$applet=y/" .config
done
# OpenSSL hashing avoids millions of tiny portable SHA round copies in the guest.
sed -i -e 's/^# CONFIG_TOYBOX_LIBCRYPTO is not set/CONFIG_TOYBOX_LIBCRYPTO=y/' \
  -e 's/^CONFIG_TOYBOX_LIBZ=y/# CONFIG_TOYBOX_LIBZ is not set/' .config
# Toybox poisons unsafe libc names that Alpine's optional fortify wrappers reference.
make -j2 OPTIMIZE='-O2 -ffunction-sections -fdata-sections -fno-asynchronous-unwind-tables -fno-strict-aliasing' CFLAGS='-U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -ffile-prefix-map=/src/toybox=toybox' LDFLAGS='-Wl,--build-id=none'
# Toybox appends OPTIMIZE after CFLAGS. Check the effective command, not its label.
grep -q -- ' -I . -O2 ' generated/build.sh
if grep -q -- '-Os' generated/build.sh; then exit 1; fi
test "$(printf abc | ./toybox sha256sum | cut -d ' ' -f 1)" = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
test "$(printf '' | ./toybox sha256sum | cut -d ' ' -f 1)" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
mkdir -p /out
cp toybox /out/toybox
cp .config /out/toybox.config
./toybox > /out/toybox.commands
cp generated/build.sh /out/toybox.build.sh
readelf -d toybox > /out/toybox.libraries.txt
mkdir -p generated/testdir
PREFIX=generated/testdir scripts/install.sh --symlink --force
NOREBUILD=1 scripts/test.sh md5sum sha1sum sha224sum sha256sum sha384sum sha512sum > /out/toybox.hash-tests.txt

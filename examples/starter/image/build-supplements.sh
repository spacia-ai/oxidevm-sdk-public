#!/bin/sh
set -eu
export LC_ALL=C SOURCE_DATE_EPOCH=1792886400
export CFLAGS='-Os -ffile-prefix-map=/src=source' LDFLAGS='-Wl,--build-id=none'
mkdir -p /out/supplements
for source in xz-5.8.4 libarchive-3.8.10 bc-7.0.3 dropbear-2026.94 curl-8.23.0; do
  mkdir -p "/src/$source"
  tar -xzf "/inputs/$source.tar.gz" -C "/src/$source" --strip-components=1
done
cd /src/xz-5.8.4
# Ship only the 0BSD core. musl provides getopt_long, so no LGPL fallback is needed.
./configure --prefix=/opt/xz --disable-shared --enable-static --disable-nls --disable-doc --disable-scripts --disable-lzmadec --disable-lzmainfo --disable-xzdec --disable-lzma-links
make -j2
make install
cp src/xz/xz /out/supplements/xz
grep -q '^#define HAVE_GETOPT_LONG 1' config.h
cp config.h /out/xz.config.h
cd /src/libarchive-3.8.10
# Retain zlib and the verified 0BSD liblzma. Disable all other optional libraries.
CPPFLAGS=-I/opt/xz/include LIBS=/opt/xz/lib/liblzma.a ./configure --disable-shared --enable-static --disable-bsdtar --disable-bsdcpio --disable-bsdcat --enable-bsdunzip --without-bz2lib --without-iconv --without-lz4 --without-zstd --without-lzo2 --without-nettle --without-openssl --without-mbedtls --without-xml2 --without-expat --disable-acl --disable-xattr
make -j2
cp bsdunzip /out/supplements/unzip
cp config.h /out/libarchive.config.h
cd /src/bc-7.0.3
# Toybox supplies bc. Build only its missing dc counterpart.
./configure.sh --dc-only --disable-history --disable-nls --disable-man-pages
make -j2
cp bin/dc /out/supplements/dc
cd /src/dropbear-2026.94
# No automatic service, accounts or host keys. Operators configure SSH explicitly.
./configure --disable-zlib --disable-syslog --disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx --disable-loginfunc --disable-pam
make -j2 PROGRAMS='dropbear dbclient dropbearkey dropbearconvert scp' MULTI=1
cp dropbearmulti /out/supplements/dropbearmulti
cp config.h /out/dropbear.config.h
cd /src/curl-8.23.0
# Toybox's minimal wget has no TLS. Provide curl with OpenSSL and no optional libraries.
./configure --disable-shared --enable-static --with-openssl --without-libpsl --without-libidn2 --without-brotli --without-zstd --without-libssh2 --without-librtmp --without-nghttp2 --without-nghttp3 --without-ngtcp2 --without-quiche --without-zlib --disable-ldap --disable-ldaps --disable-rtsp --disable-dict --disable-telnet --disable-tftp --disable-pop3 --disable-imap --disable-smtp --disable-gopher --disable-smb --disable-mqtt --disable-ftp --disable-manual --with-ca-bundle=/etc/ssl/cert.pem --without-ca-path
make -j2
cp src/curl /out/supplements/curl
cp lib/curl_config.h /out/curl.config.h

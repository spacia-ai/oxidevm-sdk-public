FROM alpine:3.24.2@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS utilities
COPY .cache/inputs/ /inputs/
COPY build-toybox.sh build-supplements.sh build-dash.sh dash-signames.c /
RUN cd /inputs && sha256sum -c SHA256SUMS \
    && apk add --no-network --no-cache /inputs/*.apk \
    && mkdir -p /src/toybox \
    && tar -xzf /inputs/toybox-0.8.15.tar.gz -C /src/toybox --strip-components=1 \
    && sh /build-toybox.sh && sh /build-supplements.sh && sh /build-dash.sh

FROM alpine:3.24.2@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS inputs
COPY .cache/inputs/ /inputs/
COPY --from=utilities /out/ /utilities/
RUN cd /inputs && sha256sum -c SHA256SUMS \
    && apk add --no-network --no-cache /inputs/nginx-1.30.6-r0.apk /inputs/pcre2-10.49-r0.apk /inputs/mksh-59c-r4.apk \
    && mkdir -p /rootfs/bin /rootfs/usr/sbin /rootfs/usr/lib /rootfs/lib /rootfs/etc /rootfs/workspace /rootfs/tmp /rootfs/proc /rootfs/dev /rootfs/run \
    && cp /utilities/toybox /rootfs/bin/toybox \
    && for applet in $(/utilities/toybox); do ln -s toybox "/rootfs/bin/$applet"; done \
    && mkdir -p /rootfs/usr/bin && ln -s ../../bin/env /rootfs/usr/bin/env \
    && cp /utilities/supplements/* /rootfs/bin/ \
    && ln -s xz /rootfs/bin/unxz \
    && for applet in dropbear dbclient dropbearkey dropbearconvert scp; do ln -s dropbearmulti "/rootfs/bin/$applet"; done \
    && ln -s dbclient /rootfs/bin/ssh \
    && cp /bin/mksh /rootfs/bin/mksh \
    && cp /utilities/dash/sh /rootfs/bin/dash \
    && ln -s dash /rootfs/bin/sh \
    && cp /usr/sbin/nginx /rootfs/usr/sbin/nginx \
    && mkdir -p /rootfs/etc/ssl/certs \
    && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ \
    && ln -s certs/ca-certificates.crt /rootfs/etc/ssl/cert.pem \
    && cp /lib/ld-musl-x86_64.so.1 /rootfs/lib/ld-musl-x86_64.so.1 \
    && ln -s ld-musl-x86_64.so.1 /rootfs/lib/libc.musl-x86_64.so.1 \
    && cp -L /usr/lib/libpcre2-8.so.0 /usr/lib/libssl.so.3 /usr/lib/libcrypto.so.3 /usr/lib/libz.so.1 /rootfs/usr/lib/ \
    && printf 'oxidevm:x:1000:1000:OxideVM:/workspace:/bin/sh\n' > /rootfs/etc/passwd \
    && printf 'oxidevm:x:1000:\n' > /rootfs/etc/group \
    && printf '127.0.0.1 localhost\n::1 localhost\n' > /rootfs/etc/hosts \
    && printf 'nameserver 192.0.2.1\n' > /rootfs/etc/resolv.conf \
    && chown 1000:1000 /rootfs/workspace \
    && chmod 1777 /rootfs/tmp

FROM scratch
COPY --from=inputs /rootfs/ /
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PATH=/usr/sbin:/usr/bin:/bin
CMD ["/bin/sh"]

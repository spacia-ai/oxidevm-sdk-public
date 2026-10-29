FROM alpine:3.24.2@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS utilities
COPY .cache/inputs/ /inputs/
COPY build-toybox.sh build-supplements.sh build-dash.sh dash-signames.c /
RUN cd /inputs && sha256sum -c SHA256SUMS \
    && apk add --no-network --no-cache /inputs/*.apk \
    && mkdir -p /src/toybox \
    && tar -xzf /inputs/toybox-0.8.15.tar.gz -C /src/toybox --strip-components=1 \
    && sh /build-toybox.sh && sh /build-supplements.sh && sh /build-dash.sh


FROM utilities AS build
COPY .cache/python-inputs/ /python-inputs/
RUN cd /python-inputs && sha256sum -c SHA256SUMS && sha256sum -c BASE.SHA256SUMS \
 && mkdir /base && tar -xzf docs-python-rootfs.tar.gz -C /base && cp -a /base/usr/. /usr/
COPY install-python-inputs.py /install-python-inputs.py
RUN /usr/bin/python3 /install-python-inputs.py \
 && /usr/bin/python3 -m zipfile -e /python-inputs/pip-25.2-py3-none-any.whl /tools \
 && /usr/bin/python3 -m venv --without-pip /build-env
ENV PYTHONPATH=/tools PATH=/build-env/bin:/usr/lib/ninja-build/bin:/usr/bin:/bin \
    CFLAGS="-O2 -march=x86-64-v2" CXXFLAGS="-O2 -march=x86-64-v2" \
    SOURCE_DATE_EPOCH=1792886400 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m pip install --no-index --find-links=/python-inputs meson==1.8.3 meson-python==0.18.0 packaging==25.0 pyproject-metadata==0.9.1 Cython==3.1.4 versioneer==0.29 wheel==0.45.1 \
 && mkdir -p /src /wheels && tar -xzf /python-inputs/numpy-2.2.6.tar.gz -C /src && tar -xzf /python-inputs/pandas-2.3.3.tar.gz -C /src \
 && python -m pip wheel --no-deps --no-index --no-build-isolation -w /wheels \
    -Csetup-args=-Dblas=none -Csetup-args=-Dlapack=none -Csetup-args=-Dallow-noblas=true \
    -Csetup-args=-Dcpu-baseline=SSE2 -Csetup-args=-Dcpu-dispatch=none -Ccompile-args=-j4 /src/numpy-2.2.6 \
 && python -m pip install --no-index --no-deps /wheels/numpy-*.whl \
 && python -m pip wheel --no-deps --no-index --no-build-isolation -w /wheels -Ccompile-args=-j4 /src/pandas-2.3.3
RUN mkdir -p /rootfs && tar -xzf /python-inputs/docs-python-rootfs.tar.gz -C /rootfs \
 && python -m pip install --no-compile --no-index --no-deps --target=/rootfs/usr/lib/python3.12/site-packages /wheels/*.whl \
    /python-inputs/python_dateutil-*.whl /python-inputs/pytz-*.whl /python-inputs/tzdata-*.whl /python-inputs/six-*.whl \
 && cp -a /usr/lib/libstdc++.so.6* /usr/lib/libgcc_s.so.1 /rootfs/usr/lib/ \
 && PYTHONPATH=/rootfs/usr/lib/python3.12/site-packages python -c 'import pandas as pd,numpy as np; assert pd.DataFrame({"a":[1,2]}).a.sum()==3; print(pd.__version__,np.__version__)' \
 && find /rootfs/usr/lib/python3.12/site-packages -type d \( -name tests -o -name __pycache__ \) -prune -exec rm -rf {} + \
 && rm -rf /rootfs/usr/lib/python3.12/site-packages/bin \
 && find /rootfs/usr/lib/python3.12/site-packages -name '*.a' -delete \
 && find /rootfs/usr/lib/python3.12/site-packages -name direct_url.json -delete \
 && PYTHONPATH= /usr/bin/python3 -m compileall -q -f --invalidation-mode checked-hash -s /rootfs -p / /rootfs/usr/lib/python3.12/site-packages \
 && ! find /rootfs -name '*quadmath*' -o -name '*gfortran*' -o -name '*openblas*' | grep .
FROM scratch
COPY --from=build /rootfs/ /
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PATH=/usr/sbin:/usr/bin:/bin
CMD ["/bin/sh"]

# Builds the example apps and serves the demo site with nginx.
# Coolify: build pack "Dockerfile", port 80. The Flutter builds need about
# 4 GB of memory and take several minutes.

FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils python3 \
 && rm -rf /var/lib/apt/lists/*
ARG FLUTTER_VERSION=3.47.2
RUN git clone --depth 1 --branch "$FLUTTER_VERSION" https://github.com/flutter/flutter.git /opt/flutter
ENV PATH="/opt/flutter/bin:$PATH"
RUN flutter config --no-analytics --enable-web && flutter precache --web
WORKDIR /src
COPY . .
RUN python3 tool/setup.py && python3 tool/serve.py --export /site

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html

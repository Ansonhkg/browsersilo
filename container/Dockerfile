FROM node:24-bookworm-slim AS agent-browser
RUN npm install --global --omit=dev agent-browser@0.32.2

FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="BrowserSilo disposable Brave worker" \
      org.opencontainers.image.version="0.4.0" \
      io.browsersilo.role="untrusted-disposable-worker"

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb xclip ffmpeg fonts-liberation fonts-noto-color-emoji \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg -o /etc/apt/keyrings/brave-browser-archive-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/brave-browser-archive-keyring.gpg arch=amd64,arm64] https://brave-browser-apt-release.s3.brave.com/ stable main" > /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends brave-browser \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin browser \
    && install -d -o browser -g browser -m 0700 /home/browser/.cache /home/browser/.config /home/browser/.brave-profile /run/browsersilo

COPY --from=agent-browser /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-browser /usr/local/lib/node_modules/agent-browser /usr/local/lib/node_modules/agent-browser
RUN ln -s /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser \
    && chmod 0755 /usr/local/bin/agent-browser \
    && install -d -m 0755 /opt/browsersilo
COPY --chmod=0755 container/entrypoint.sh /usr/local/bin/browsersilo-worker
COPY --chmod=0644 container/egress-proxy.mjs /opt/browsersilo/egress-proxy.mjs
COPY --chmod=0644 container/close-browser.mjs /opt/browsersilo/close-browser.mjs
COPY --chmod=0644 container/grant-clipboard.mjs /opt/browsersilo/grant-clipboard.mjs

USER browser
ENV DISPLAY=:99 \
    HOME=/home/browser
EXPOSE 9222
ENTRYPOINT ["/usr/local/bin/browsersilo-worker"]

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl unzip libstdc++6 libboost-filesystem1.74.0 libboost-log1.74.0 libuuid1 procps supervisor && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 agent && mkdir -p /opt/probe && chown agent:agent /opt/probe
WORKDIR /opt/probe
COPY --chown=agent:agent package.json package-lock.json install-cli.mjs ./
USER agent
RUN npm ci --omit=dev --ignore-scripts && node install-cli.mjs
COPY --chown=agent:agent probe.mjs release-lock.json verify-release.py ./
RUN python3 verify-release.py
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/opt/probe/probe.mjs"]

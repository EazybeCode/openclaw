FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Install Python3 and pip for MCP skills (BigQuery, HubSpot)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Python packages for MCP skills
# - pymongo: HubSpot MCP skill (MongoDB token lookup)
# - mcp: Qdrant MCP skill (SSE transport)
RUN pip3 install --no-cache-dir --break-system-packages pymongo mcp

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# BigQuery MCP server URL
ENV BIGQUERY_MCP_URL=http://ck8c84oo40gkcwwk4gcokco0.5.161.117.36.sslip.io

# Qdrant MCP server URL (knowledge base semantic search)
ENV QDRANT_MCP_URL=http://gw80os8k0kcgc488o0gw0so8.5.161.117.36.sslip.io

# HubSpot OAuth credentials (for token refresh)
ENV HUBSPOT_CLIENT_ID="0c40c683-cfae-43cf-9450-7eefa4f4a752"
ENV HUBSPOT_CLIENT_SECRET="5cc628fe-1d67-463f-a0b3-3d3c13dbf390"

# HubSpot MCP access token (fallback, not needed with MongoDB)
ENV HUBSPOT_ACCESS_TOKEN=""

# REV AGENT URL (planning + orchestration)
ENV REV_AGENT_URL=http://jwcscw0g84o8c4k84w4s0oss.5.161.117.36.sslip.io

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Create OpenClaw config directory with HTTP endpoints, auth, and exec permissions
RUN mkdir -p /home/node/.openclaw && \
    echo '{"gateway":{"mode":"local","http":{"enabled":true,"endpoints":{"chatCompletions":{"enabled":true},"responses":{"enabled":true}}},"auth":{"allowUnconfigured":true}},"tools":{"exec":{"host":"gateway","security":"full","ask":"off"}}}' > /home/node/.openclaw/openclaw.json && \
    chown -R node:node /home/node/.openclaw

# Install mcp-adapter plugin via openclaw CLI
RUN node dist/index.js plugins install mcp-adapter || echo "mcp-adapter plugin not available in registry, skipping"

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with LAN binding for Docker access
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "lan"]

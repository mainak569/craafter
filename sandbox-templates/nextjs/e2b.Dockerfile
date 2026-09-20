# Same Node and Debian as the first template build
FROM node:21.7.3-slim

# Install curl
RUN apt-get update && apt-get install -y curl && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY compile_page.sh /compile_page.sh
RUN chmod +x /compile_page.sh

# The Next.js app the agent builds on. app-template/ is a snapshot of what
# create-next-app@15.3.3 and `shadcn@2.6.3 add --all` produced, installed from its
# lockfile, so rebuilding the template doesn't change the agent's environment.
COPY app-template/ /home/user/
WORKDIR /home/user
RUN npm ci --no-audit --no-fund

# Headless Chromium for the smoke test that clicks through generated apps
# (src/inngest/utils.ts). Kept outside the app so the agent never sees it.
RUN mkdir -p /opt/smoke && cd /opt/smoke \
  && npm init -y > /dev/null \
  && npm install --no-audit --no-fund playwright-core@1.63.0 \
  && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright npx playwright-core install --with-deps --only-shell chromium \
  && chmod -R a+rX /opt/playwright /opt/smoke

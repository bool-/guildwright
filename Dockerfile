# THE ENGINE CHECKOUT's image: runs the engine straight from source, exactly as `npm start` does
# here. Node strips the types itself, so there is no build step and no dev dependencies in the
# image. A module repository runs the INSTALLED engine instead; its Dockerfile is in
# docs/SETUP.md section 9.
#
#   docker compose up -d --build        (see compose.yaml and docs/SETUP.md "Running it long-term")
#
# Secrets are NOT in this image. `.env` is passed in at run time by compose's `env_file`, and
# `.dockerignore` keeps `.env`, `data/` and `.git` out of the build context entirely.

# Must satisfy "engines" in package.json (>=24.12.0).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
# --ignore-scripts: no install script runs at build time (and `prepack` is not wanted here).
# --omit=dev: typescript and oxlint are check-time tools; zod is a peer dependency, which npm
# installs for a root package anyway.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# The SQLite database (DATABASE_PATH defaults to ./data/bot.sqlite). Mount a volume here.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# The image has no .git, so the build identity in /status comes from here. compose.yaml passes
# `GIT_SHA` through; leave it unset and /status says the sha is unknown rather than guessing.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

# Not root: code merged by the builder module runs in this process, so it should hold as few
# rights as possible.
USER node

# `--conditions=source` is required: without it `#core/*` resolves to dist/, which does not
# exist here, and the bot exits with ERR_MODULE_NOT_FOUND before printing anything.
CMD ["node", "--conditions=source", "src/main.ts"]

# -----------------------------------------------------------------------------
# STAGE 1: Install dependencies
# -----------------------------------------------------------------------------
FROM node:26-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci


# -----------------------------------------------------------------------------
# STAGE 2: Build Next.js
# -----------------------------------------------------------------------------
FROM node:26-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build


# -----------------------------------------------------------------------------
# STAGE 3: Minimal production runtime
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENV AWS_LWA_PORT=3000
ENV AWS_LWA_READINESS_CHECK_PATH=/api/health
ENV AWS_LWA_READINESS_CHECK_HEALTHY_STATUS=200-399
ENV AWS_LWA_INVOKE_MODE=response_stream
ENV AWS_LWA_ERROR_STATUS_CODES=500-599

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 \
  /lambda-adapter /opt/extensions/lambda-adapter

COPY --from=builder --chown=65532:65532 \
  /app/.next/standalone ./

COPY --from=builder --chown=65532:65532 \
  /app/.next/static ./.next/static

EXPOSE 3000

# The distroless Node image already has "node" as its entrypoint.
CMD ["server.js"]
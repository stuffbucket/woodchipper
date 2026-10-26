# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS jose-builder
ARG NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=always \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
WORKDIR /work/jose

# Build dependencies come through the configured registry proxy. The npmrc is a
# BuildKit secret, so credentials never enter the build context or image layers.
COPY jose/package.json jose/package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --ignore-scripts --no-audit --no-fund

COPY jose/ ./
RUN rm -rf dist \
    && ./node_modules/.bin/tsc \
    && node tools/minify-syntax.js \
    && ./node_modules/.bin/tsc -p ./tsconfig/types.json \
    && (cd src && find . -name '*.d.ts' -type f -exec cp --parents '{}' ../dist/types/ ';') \
    && node tools/declaration-comments.js \
    && node --input-type=module -e "const mod = await import('./dist/webapi/index.js'); if (typeof mod.jwtVerify !== 'function') throw new Error('jose build smoke test failed')"

RUN mkdir -p /out/jose \
    && cp package.json LICENSE.md README.md /out/jose/ \
    && cp -R dist /out/jose/

FROM ${NODE_IMAGE} AS fast-uri-builder
WORKDIR /work/fast-uri
COPY fast-uri/ ./

# fast-uri ships as source JavaScript. Package and exercise the security fixes
# in the container rather than mutating or executing the checked-out submodule.
RUN node <<'NODE'
const uri = require('./index.js')
const encodedScheme = '%6Aavascript:alert(1)'
if (uri.normalize(encodedScheme) !== encodedScheme) {
  throw new Error('fast-uri encoded-scheme normalization smoke test failed')
}
if (uri.equal(encodedScheme, 'javascript:alert(1)')) {
  throw new Error('fast-uri encoded-scheme equality smoke test failed')
}
if (!uri.parse('http://a@b@evil.example/').error) {
  throw new Error('fast-uri host canonicalization smoke test failed')
}
NODE

RUN mkdir -p /out/fast-uri \
    && cp package.json LICENSE README.md index.js /out/fast-uri/ \
    && cp -R lib types /out/fast-uri/

FROM scratch AS package-export
COPY --from=jose-builder /out/jose /jose
COPY --from=fast-uri-builder /out/fast-uri /fast-uri

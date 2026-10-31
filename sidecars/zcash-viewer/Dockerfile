# syntax=docker/dockerfile:1.7
# zcash-viewer: watch-only Zcash light client sidecar (linux/amd64, linux/arm64).
#
# The build stage always runs on the builder's native platform and
# cross-compiles for the target, so arm64 images don't compile ~400 crates
# under QEMU emulation.
ARG RUST_VERSION=1.98

FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-bookworm AS build
ARG TARGETARCH
ARG BUILDARCH
WORKDIR /src

# Cross toolchain only when target and builder differ. perl/make for the
# vendored OpenSSL used by SQLCipher are already in the rust image.
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) triple=x86_64-unknown-linux-gnu; gnu=x86_64-linux-gnu; pkg=gcc-x86-64-linux-gnu; libc=libc6-dev-amd64-cross ;; \
    arm64) triple=aarch64-unknown-linux-gnu; gnu=aarch64-linux-gnu; pkg=gcc-aarch64-linux-gnu; libc=libc6-dev-arm64-cross ;; \
    *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
  esac; \
  echo "$triple" > /target-triple; \
  if [ "$TARGETARCH" != "$BUILDARCH" ]; then \
    apt-get update; \
    apt-get install -y --no-install-recommends "$pkg" "$libc"; \
    rm -rf /var/lib/apt/lists/*; \
    t=$(echo "$triple" | tr '-' '_'); T=$(echo "$t" | tr 'a-z' 'A-Z'); \
    { echo "export CARGO_TARGET_${T}_LINKER=${gnu}-gcc"; \
      echo "export CC_${t}=${gnu}-gcc"; \
      echo "export CXX_${t}=${gnu}-g++"; \
      echo "export AR_${t}=${gnu}-ar"; } > /cross-env; \
  else \
    : > /cross-env; \
  fi; \
  rustup target add "$triple"

# Dependencies first, in their own layer, so source edits don't rebuild them.
COPY Cargo.toml Cargo.lock ./
RUN --mount=type=cache,id=zcash-viewer-registry,target=/usr/local/cargo/registry \
  set -eux; . /cross-env; \
  mkdir src && echo 'fn main() {}' > src/main.rs; \
  cargo build --release --locked --target "$(cat /target-triple)"; \
  rm -rf src

COPY src ./src
RUN --mount=type=cache,id=zcash-viewer-registry,target=/usr/local/cargo/registry \
  set -eux; . /cross-env; \
  touch src/main.rs; \
  cargo build --release --locked --target "$(cat /target-triple)"; \
  install -D "target/$(cat /target-triple)/release/zcash-viewer" /out/zcash-viewer; \
  mkdir -p /out/data

# glibc + libgcc only; SQLCipher and OpenSSL are statically linked. No shell.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=build /out/zcash-viewer /usr/local/bin/zcash-viewer
COPY --from=build --chown=65532:65532 /out/data /data
ENV ZCASH_VIEWER_DB=/data/wallet.db \
    ZCASH_VIEWER_LISTEN=0.0.0.0:8232
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8232
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/zcash-viewer", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/zcash-viewer"]

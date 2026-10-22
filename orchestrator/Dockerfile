FROM rust:1-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config build-essential cmake && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim

COPY --from=build /app/target/release/orchestrator /usr/local/bin/orchestrator

EXPOSE 8000

CMD ["orchestrator"]

#!/bin/sh
# Faster dev install than `cargo install --path` (skips fingerprint churn).
set -e
cargo build --release
cp target/release/rauncha ~/.cargo/bin/

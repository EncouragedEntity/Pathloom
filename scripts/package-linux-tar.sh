#!/usr/bin/env bash
# Packs the Linux release binaries into pathloom-<tag>-x86_64-unknown-linux-gnu.tar.gz (flat layout)
# and writes <archive>.sha256 next to it (checked with `sha256sum -c`).
# Run after `tauri build` on Linux: needs target/release/pathloom and target/release/pathloom-desktop.
# Usage: scripts/package-linux-tar.sh <tag> [bin-dir]
set -euo pipefail
tag="${1:?usage: package-linux-tar.sh <tag> [bin-dir]}"
bin="${2:-target/release}"
# The tag ends up in a file name and a release upload: allow only vX.Y.Z[-suffix].
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "Invalid tag: $tag" >&2; exit 1; }
name="pathloom-${tag}-x86_64-unknown-linux-gnu"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$bin/pathloom" "$bin/pathloom-desktop" LICENSE-MIT LICENSE-APACHE THIRD-PARTY-LICENSES.md README.md "$stage/"
chmod 755 "$stage/pathloom" "$stage/pathloom-desktop"
chmod 644 "$stage/LICENSE-MIT" "$stage/LICENSE-APACHE" "$stage/THIRD-PARTY-LICENSES.md" "$stage/README.md"
# Owner root:root so the runner's user name does not leak into the archive.
tar --owner=0 --group=0 --numeric-owner -czf "$name.tar.gz" -C "$stage" .
sha256sum "$name.tar.gz" > "$name.tar.gz.sha256"
tar -tzvf "$name.tar.gz"
cat "$name.tar.gz.sha256"

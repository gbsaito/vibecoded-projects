#!/usr/bin/env bash
# steamtui installer — installs from the GitHub release tarball.
# Usage: curl -fsSL https://raw.githubusercontent.com/gbsaito/steamtui/master/install.sh | bash
set -euo pipefail

REPO="gbsaito/steamtui"
VERSION="v0.1.0"
INSTALL_DIR="${STEAMTUI_INSTALL_DIR:-$HOME/.local/share/steamtui}"
BIN_DIR="${STEAMTUI_BIN_DIR:-$HOME/.local/bin}"

echo "steamtui installer (version $VERSION)"
echo "install dir: $INSTALL_DIR"

need() { command -v "$1" >/dev/null 2>&1; }

# 1. bun (required runtime)
if ! need bun; then
  echo "bun not found — installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
if ! need bun; then
  echo "error: bun is required and could not be installed (https://bun.sh)" >&2
  exit 1
fi

# 2. download + extract the release tarball
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading release tarball..."
curl -fsSL "https://github.com/${REPO}/archive/refs/tags/${VERSION}.tar.gz" -o "$TMP/steamtui.tar.gz"
mkdir -p "$TMP/extract"
tar -xzf "$TMP/steamtui.tar.gz" -C "$TMP/extract"
SRC="$(find "$TMP/extract" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$SRC" ] || { echo "error: could not find extracted source directory" >&2; exit 1; }

# 3. replace the install dir with the fresh copy
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete
cp -a "$SRC/." "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/bin/steamtui"

# 4. install dependencies
echo "installing dependencies..."
( cd "$INSTALL_DIR" && bun install --frozen-lockfile || bun install )

# 5. launcher
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/steamtui" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$INSTALL_DIR/bin/steamtui" "\$@"
EOF
chmod +x "$BIN_DIR/steamtui"

echo
echo "steamtui installed to: $INSTALL_DIR"
echo "launcher:            $BIN_DIR/steamtui"
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "note: $BIN_DIR is not on your PATH. Add it, e.g.:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\"   # add to ~/.zshrc or ~/.bashrc"
fi
echo
echo "run it with: steamtui"

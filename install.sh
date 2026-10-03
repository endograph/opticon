#!/bin/sh
# Installs the opticon CLI from GitHub releases.
#
#   curl -fsSL https://opticon.tv/install.sh | sh
#
# Environment:
#   OPTICON_VERSION=0.1.0       install a specific version instead of the latest
#   OPTICON_INSTALL_DIR=<dir>   install the binary here (default ~/.opticon/bin)
#   OPTICON_NO_MODIFY_PATH=1    don't add the install dir to your shell profile
set -eu

REPO="endograph/opticon"
INSTALL_DIR="${OPTICON_INSTALL_DIR:-$HOME/.opticon/bin}"

fail() {
  echo "opticon install: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v gunzip >/dev/null 2>&1 || fail "gunzip is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); opticon runs on macOS and Linux" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# An x64 shell under Rosetta on Apple silicon should still get the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

asset="opticon-$os-$arch.gz"
if [ -n "${OPTICON_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/v${OPTICON_VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset..."
curl -fsSL --proto '=https' "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL --proto '=https' "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "no checksum for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"

gunzip -c "$tmp/$asset" >"$tmp/opticon" || fail "couldn't decompress $asset"
chmod 755 "$tmp/opticon"
mkdir -p "$INSTALL_DIR"
mv "$tmp/opticon" "$INSTALL_DIR/opticon"
version="$("$INSTALL_DIR/opticon" version)" || fail "installed binary failed to run"
echo "Installed opticon $version to $INSTALL_DIR/opticon"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

if [ "$on_path" = 0 ]; then
  profile=""
  line="export PATH=\"$INSTALL_DIR:\$PATH\""
  case "$(basename "${SHELL:-}")" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
    fish)
      profile="$HOME/.config/fish/config.fish"
      line="fish_add_path \"$INSTALL_DIR\""
      ;;
  esac
  if [ -n "$profile" ] && [ -z "${OPTICON_NO_MODIFY_PATH:-}" ]; then
    if ! grep -qsF "$INSTALL_DIR" "$profile"; then
      mkdir -p "$(dirname "$profile")"
      printf '\n# opticon\n%s\n' "$line" >>"$profile"
      echo "Added $INSTALL_DIR to PATH in $profile"
    fi
    echo "Restart your shell or run: $line"
  else
    echo "Add $INSTALL_DIR to your PATH: $line"
  fi
fi

echo
echo "Get started: opticon web"

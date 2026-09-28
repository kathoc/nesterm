#!/bin/sh

set -eu
set -f

PROGRAM=nesterm
DEFAULT_VERSION=0.1.0
NODE_VERSION=24.21.0
stage=

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'nesterm installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$stage" ] && [ -d "$stage" ]; then
    rm -rf "$stage"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat <<'EOF'
Install nesterm into a user-owned prefix.

Usage: sh install.sh [--help]

Environment:
  NESTERM_PREFIX            install prefix (default: $HOME/.local)
  NESTERM_VERSION           release version (default: 0.1.0)

NESTERM_RELEASE_BASE_URL, NESTERM_NODE_BASE_URL, and
NESTERM_FORCE_NODE_DOWNLOAD are intended for installer tests.
EOF
}

case ${1-} in
  '') ;;
  -h|--help)
    usage
    exit 0
    ;;
  *) die "unknown argument: $1" ;;
esac
[ "$#" -le 1 ] || die "too many arguments"

version=${NESTERM_VERSION:-$DEFAULT_VERSION}
case $version in
  ''|*[!A-Za-z0-9._-]*) die "NESTERM_VERSION contains unsupported characters" ;;
esac

if [ "${NESTERM_PREFIX+x}" = x ]; then
  prefix=$NESTERM_PREFIX
else
  [ -n "${HOME:-}" ] || die 'HOME is unset; set NESTERM_PREFIX to an absolute path'
  prefix=$HOME/.local
fi

case $prefix in
  /*) ;;
  *) die "NESTERM_PREFIX must be an absolute path" ;;
esac
case "/$prefix/" in
  */../*|*/./*) die "NESTERM_PREFIX must not contain . or .. path components" ;;
esac

mkdir -p "$prefix" || die "cannot create prefix: $prefix"
prefix=$(CDPATH= cd -P "$prefix" && pwd) || die "cannot resolve prefix: $prefix"
[ "$prefix" != / ] || die 'NESTERM_PREFIX must not be the filesystem root'

stage=$(mktemp -d "$prefix/.nesterm-install.XXXXXX") || die 'cannot create staging directory'

download() {
  download_url=$1
  download_output=$2

  if command -v curl >/dev/null 2>&1; then
    curl -fL --silent --show-error \
      --connect-timeout 15 --max-time 300 --retry 2 \
      --output "$download_output" "$download_url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -t 2 -O "$download_output" "$download_url" &
    wget_pid=$!
    (
      sleep 300
      kill "$wget_pid" 2>/dev/null || :
    ) &
    watchdog_pid=$!
    if wait "$wget_pid"; then
      wget_status=0
    else
      wget_status=$?
    fi
    kill "$watchdog_pid" 2>/dev/null || :
    wait "$watchdog_pid" 2>/dev/null || :
    [ "$wget_status" -eq 0 ] || return "$wget_status"
    return
  fi

  die 'curl or wget is required'
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    die 'sha256sum or shasum is required'
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
  else
    die 'sha256sum or shasum is required'
  fi
}

expected_hash() {
  sums_file=$1
  wanted_name=$2
  awk -v wanted="$wanted_name" '
    $2 == wanted || $2 == "*" wanted { print $1 }
  ' "$sums_file"
}

verify_file() {
  verify_path=$1
  verify_name=$2
  verify_sums=$3
  expected=$(expected_hash "$verify_sums" "$verify_name")

  case $expected in
    ''|*[!0-9A-Fa-f]*) die "missing or invalid SHA-256 for $verify_name" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "invalid SHA-256 length for $verify_name"
  actual=$(sha256_file "$verify_path")
  [ "$actual" = "$expected" ] || die "SHA-256 mismatch for $verify_name"
  printf '%s\n' "$actual"
}

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || :
}

system_node=
if [ "${NESTERM_FORCE_NODE_DOWNLOAD:-0}" != 1 ] && command -v node >/dev/null 2>&1; then
  candidate_node=$(node -p 'process.execPath' 2>/dev/null || :)
  case $candidate_node in
    /*)
      candidate_major=$(node_major "$candidate_node")
      case $candidate_major in
        ''|*[!0-9]*) ;;
        *)
          if [ "$candidate_major" -ge 20 ]; then
            system_node=$candidate_node
          fi
          ;;
      esac
      ;;
  esac
fi

release_base=${NESTERM_RELEASE_BASE_URL:-https://github.com/kathoc/nesterm/releases/download/v$version}
release_base=${release_base%/}
archive_name=nesterm-$version.tgz
archive_path=$stage/$archive_name
sums_path=$stage/SHA256SUMS

say "Downloading nesterm $version..."
download "$release_base/SHA256SUMS" "$sums_path" || die 'could not download SHA256SUMS'
download "$release_base/$archive_name" "$archive_path" || die "could not download $archive_name"
archive_hash=$(verify_file "$archive_path" "$archive_name" "$sums_path")

tar -tzf "$archive_path" > "$stage/archive.list" || die 'release archive is not a readable gzip tar archive'
[ -s "$stage/archive.list" ] || die 'release archive is empty'
while IFS= read -r archive_entry; do
  case $archive_entry in
    package|package/*) ;;
    *) die "unsafe release archive entry: $archive_entry" ;;
  esac
  case "/$archive_entry/" in
    */../*|*/./*) die "unsafe release archive entry: $archive_entry" ;;
  esac
done < "$stage/archive.list"

tar -tvzf "$archive_path" > "$stage/archive.verbose" || die 'cannot inspect release archive'
if awk 'substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { found=1 } END { exit !found }' "$stage/archive.verbose"; then
  die 'release archive contains links'
fi

payload=$stage/payload
mkdir -p "$payload"
tar -xzf "$archive_path" -C "$payload" || die 'could not extract release archive'
[ -f "$payload/package/bin/nesterm.mjs" ] || die 'release archive does not contain package/bin/nesterm.mjs'

runtime_key=
if [ -z "$system_node" ]; then
  case $(uname -s) in
    Linux) node_os=linux ;;
    Darwin) node_os=darwin ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
  case $(uname -m) in
    x86_64|amd64) node_arch=x64 ;;
    arm64|aarch64) node_arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  node_name=node-v$NODE_VERSION-$node_os-$node_arch
  runtime_key=$node_name
  node_archive=$node_name.tar.gz
  node_base=${NESTERM_NODE_BASE_URL:-https://nodejs.org/dist/v$NODE_VERSION}
  node_base=${node_base%/}
  node_archive_path=$stage/$node_archive
  node_sums=$stage/SHASUMS256.txt

  say "Downloading private Node.js $NODE_VERSION runtime..."
  download "$node_base/SHASUMS256.txt" "$node_sums" || die 'could not download Node.js checksums'
  download "$node_base/$node_archive" "$node_archive_path" || die 'could not download Node.js runtime'
  verify_file "$node_archive_path" "$node_archive" "$node_sums" >/dev/null

  tar -tzf "$node_archive_path" > "$stage/node-archive.list" || die 'Node.js archive is unreadable'
  if ! awk -v node="$node_name/bin/node" -v license="$node_name/LICENSE" '
    $0 == node { found_node=1 }
    $0 == license { found_license=1 }
    END { exit !(found_node && found_license) }
  ' "$stage/node-archive.list"; then
    die 'Node.js archive does not contain the expected runtime and license'
  fi
  mkdir -p "$payload/runtime"
  tar -xzf "$node_archive_path" -C "$payload/runtime" \
    "$node_name/bin/node" "$node_name/LICENSE" || die 'could not extract Node.js runtime'
  private_node=$payload/runtime/$node_name/bin/node
  private_license=$payload/runtime/$node_name/LICENSE
  [ -f "$private_node" ] && [ ! -L "$private_node" ] || die 'downloaded Node.js runtime is not a regular file'
  [ -f "$private_license" ] && [ ! -L "$private_license" ] || die 'downloaded Node.js license is not a regular file'
  chmod 755 "$private_node"
  private_major=$(node_major "$private_node")
  case $private_major in
    ''|*[!0-9]*) die 'downloaded Node.js runtime could not be executed' ;;
    *) [ "$private_major" -ge 20 ] || die 'downloaded Node.js runtime is older than version 20' ;;
  esac
  mv "$private_node" "$payload/runtime/node"
  mv "$private_license" "$payload/runtime/LICENSE"
  rmdir "$payload/runtime/$node_name/bin" "$payload/runtime/$node_name"
else
  system_node_hash=$(printf '%s' "$system_node" | sha256_stdin)
  runtime_key=system-$system_node_hash
  mkdir -p "$payload/runtime"
  printf '%s\n' "$system_node" > "$payload/runtime/system-node"
fi

printf '%s\n' 'nesterm-installer-payload-v1' > "$payload/.nesterm-payload"

install_root=$prefix/lib/nesterm
versions_dir=$install_root/versions
managed_marker=$install_root/.nesterm-managed
launcher=$prefix/bin/nesterm

for required_dir in "$prefix/lib" "$prefix/bin"; do
  if [ -e "$required_dir" ] || [ -L "$required_dir" ]; then
    [ -d "$required_dir" ] && [ ! -L "$required_dir" ] || \
      die "refusing to use non-directory or linked path: $required_dir"
  fi
done

if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  [ -d "$install_root" ] && [ ! -L "$install_root" ] || die "managed path is not a directory: $install_root"
  [ -f "$managed_marker" ] && [ ! -L "$managed_marker" ] && \
    grep -qx 'nesterm-installer-root-v1' "$managed_marker" || \
    die "refusing to replace unmanaged path: $install_root"
fi

if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ -f "$launcher" ] && [ ! -L "$launcher" ] && \
    grep -q '^# nesterm-installer-launcher-v1$' "$launcher" || \
    die "refusing to replace unmanaged launcher: $launcher"
fi

if [ -e "$versions_dir" ] || [ -L "$versions_dir" ]; then
  [ -d "$versions_dir" ] && [ ! -L "$versions_dir" ] || \
    die "refusing to use non-directory or linked path: $versions_dir"
fi

payload_key=$version-$archive_hash-$runtime_key
installed_payload=$versions_dir/$payload_key
if [ -e "$installed_payload" ] || [ -L "$installed_payload" ]; then
  [ -d "$installed_payload" ] && [ ! -L "$installed_payload" ] && \
    [ -f "$installed_payload/.nesterm-payload" ] && [ ! -L "$installed_payload/.nesterm-payload" ] && \
    grep -qx 'nesterm-installer-payload-v1' "$installed_payload/.nesterm-payload" || \
    die "refusing to replace unmanaged payload: $installed_payload"
fi

current_link=$install_root/current
if [ -e "$current_link" ] && [ ! -L "$current_link" ]; then
  die "refusing to replace non-link path: $current_link"
fi

mkdir -p "$versions_dir" "$prefix/bin"
if [ ! -f "$managed_marker" ]; then
  printf '%s\n' 'nesterm-installer-root-v1' > "$managed_marker"
fi
if [ ! -e "$installed_payload" ] && [ ! -L "$installed_payload" ]; then
  mv "$payload" "$installed_payload"
fi

new_link=$install_root/.current.$$
[ ! -e "$new_link" ] && [ ! -L "$new_link" ] || die 'temporary current link already exists'
ln -s "versions/$payload_key" "$new_link"
if [ -L "$current_link" ]; then
  rm "$current_link"
fi
mv "$new_link" "$current_link"

launcher_tmp=$stage/nesterm-launcher
cat > "$launcher_tmp" <<'EOF'
#!/bin/sh
# nesterm-installer-launcher-v1
set -eu
case $0 in
  */*) launcher_path=$0 ;;
  *) launcher_path=$(command -v "$0") ;;
esac
launcher_dir=$(CDPATH= cd -P "${launcher_path%/*}" && pwd)
install_root=$launcher_dir/../lib/nesterm
if [ -x "$install_root/current/runtime/node" ]; then
  node_command=$install_root/current/runtime/node
elif [ -r "$install_root/current/runtime/system-node" ]; then
  IFS= read -r node_command < "$install_root/current/runtime/system-node"
  case $node_command in
    /*) ;;
    *)
      printf '%s\n' 'nesterm: invalid managed Node.js path' >&2
      exit 1
      ;;
  esac
  if [ ! -x "$node_command" ]; then
    printf 'nesterm: managed Node.js is unavailable: %s\n' "$node_command" >&2
    exit 1
  fi
else
  printf '%s\n' 'nesterm: managed Node.js runtime is missing' >&2
  exit 1
fi
exec "$node_command" "$install_root/current/package/bin/nesterm.mjs" "$@"
EOF
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"

say "Installed nesterm $version."
say "Launcher: $launcher"

path_found=0
old_ifs=$IFS
IFS=:
for path_entry in ${PATH:-}; do
  [ -n "$path_entry" ] || path_entry=.
  if [ "$path_entry" = "$prefix/bin" ]; then
    path_found=1
    break
  fi
done
IFS=$old_ifs
if [ "$path_found" -eq 0 ]; then
  quoted_bin=$(printf '%s' "$prefix/bin" | sed "s/'/'\\\\''/g")
  say "For this shell: export PATH='$quoted_bin':\$PATH"
fi
say "You can always run it directly as: $launcher"

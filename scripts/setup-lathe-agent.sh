#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
config_dir="${HOME:?HOME is not set}/.lathe"

if [ ! -d "$config_dir" ]; then
  mkdir -p "$config_dir"
  printf 'created %s\n' "$config_dir"
else
  mkdir -p "$config_dir"
fi

link_path() {
  dest=$1
  target=$2

  if [ -L "$dest" ]; then
    current=$(readlink "$dest")
    if [ "$current" != "$target" ]; then
      rm "$dest"
      ln -s "$target" "$dest"
    fi
  elif [ -e "$dest" ]; then
    printf 'refusing to replace non-symlink %s\n' "$dest" >&2
    exit 1
  else
    ln -s "$target" "$dest"
  fi

  printf 'linked %s -> %s\n' "$dest" "$target"
}

link_path "$config_dir/skills" "$repo_root/agent/skills"
link_path "$config_dir/CLAUDE.md" "$repo_root/agent/CLAUDE.md"
link_path "$config_dir/settings.json" "$repo_root/agent/settings.json"

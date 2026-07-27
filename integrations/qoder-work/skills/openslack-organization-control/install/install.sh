#!/usr/bin/env bash
set -euo pipefail

skill_name="openslack-organization-control"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="$(cd -- "${script_dir}/.." && pwd -P)"
target_root="${QODER_SKILLS_ROOT:-${HOME}/.qoderwork/skills}"

usage() {
  printf '%s\n' \
    "Usage: install.sh [--target-root ABSOLUTE_PATH]" \
    "" \
    "Installs ${skill_name} into a fixed child of the Qoder Work skills root."
}

while (($# > 0)); do
  case "$1" in
    --target-root)
      if (($# < 2)); then
        printf 'install.sh: --target-root requires a value\n' >&2
        exit 2
      fi
      target_root="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$target_root" in
  /*) ;;
  *)
    printf 'install.sh: target root must be an absolute path\n' >&2
    exit 2
    ;;
esac

canonicalize_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$1"
  elif command -v readlink >/dev/null 2>&1 && readlink -m -- "$1" >/dev/null 2>&1; then
    readlink -m -- "$1"
  else
    printf 'install.sh: canonical path resolution is unavailable\n' >&2
    return 2
  fi
}

reject_symlink_components() {
  local candidate="$1"
  local current="/"
  local component
  local -a components
  IFS='/' read -r -a components <<< "${candidate#/}"
  for component in "${components[@]}"; do
    if [[ -z "$component" || "$component" == "." ]]; then
      continue
    fi
    if [[ "$component" == ".." ]]; then
      current="$(dirname -- "$current")"
      continue
    fi
    current="${current%/}/${component}"
    if [[ -L "$current" ]]; then
      printf 'install.sh: refusing a symlink component in target root\n' >&2
      return 2
    fi
  done
}

is_broad_root() {
  local candidate="$1"
  local relative="${candidate#/}"
  if [[ -z "$relative" || "$relative" != */* ]]; then
    return 0
  fi
  case "$relative" in
    mnt/*|media/*|Volumes/*)
      [[ "${relative#*/}" != */* ]] && return 0
      ;;
  esac
  return 1
}

requested_target_root="$target_root"
target_root="$(canonicalize_path "$requested_target_root")"
home_root="$(canonicalize_path "$HOME")"

if [[ "$target_root" == "$home_root" ]] || is_broad_root "$target_root"; then
  printf 'install.sh: refusing filesystem, home, or broad directory as target root\n' >&2
  exit 2
fi
reject_symlink_components "$requested_target_root"

mkdir -p -- "$target_root"
reject_symlink_components "$requested_target_root"
created_target_root="$(canonicalize_path "$requested_target_root")"
if [[ "$created_target_root" != "$target_root" ]]; then
  printf 'install.sh: target root changed during canonicalization\n' >&2
  exit 2
fi
target_dir="${target_root}/${skill_name}"

case "${target_dir}/" in
  "${source_dir}/"*)
    printf 'install.sh: refusing a target nested inside the source Skill\n' >&2
    exit 2
    ;;
esac

if [[ -L "$target_dir" ]]; then
  printf 'install.sh: refusing a symlink target Skill\n' >&2
  exit 2
fi
if [[ -e "$target_dir" && ! -d "$target_dir" ]]; then
  printf 'install.sh: target Skill exists and is not a directory\n' >&2
  exit 2
fi

stage_dir=""
backup_dir=""

cleanup() {
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
  if [[ -n "$backup_dir" && -d "$backup_dir" && ! -e "$target_dir" ]]; then
    mv -- "$backup_dir" "$target_dir"
  fi
}
trap cleanup EXIT

stage_dir="$(mktemp -d "${target_root}/.${skill_name}.tmp.XXXXXX")"
cp -R -- "${source_dir}/." "${stage_dir}/"

if [[ -d "$target_dir" ]] && diff -qr -- "$stage_dir" "$target_dir" >/dev/null; then
  printf '%s is already up to date at %s\n' "$skill_name" "$target_dir"
  exit 0
fi

if [[ -d "$target_dir" ]]; then
  backup_dir="${target_root}/.${skill_name}.backup.$$"
  if [[ -e "$backup_dir" ]]; then
    printf 'install.sh: refusing to replace an existing backup path\n' >&2
    exit 2
  fi
  mv -- "$target_dir" "$backup_dir"
fi

mv -- "$stage_dir" "$target_dir"
stage_dir=""

if [[ -n "$backup_dir" ]]; then
  rm -rf -- "$backup_dir"
  backup_dir=""
fi

printf 'Installed %s at %s\n' "$skill_name" "$target_dir"

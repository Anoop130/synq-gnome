#!/usr/bin/env bash
# builds synq-gnome@rsim.shell-extension.zip for extensions.gnome.org upload.
# only files inside synq-gnome@rsim/ are included (same layout as wakapanel@rsim).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID_DIR="${ROOT}/synq-gnome@rsim"
OUT="${ROOT}/synq-gnome@rsim.shell-extension.zip"

if [[ ! -f "${UUID_DIR}/extension.js" ]] || [[ ! -f "${UUID_DIR}/metadata.json" ]]; then
    echo "[ERROR] missing extension.js or metadata.json in ${UUID_DIR}" >&2
    exit 1
fi

if [[ -f "${UUID_DIR}/schemas/gschemas.compiled" ]]; then
    echo "[ERROR] remove schemas/gschemas.compiled before packing (ego rejects it for shell 45+)" >&2
    exit 1
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions pack -f -o "${ROOT}" "${UUID_DIR}"
    echo "[INFO] created ${OUT}"
    unzip -l "${OUT}"
    exit 0
fi

echo "[WARN] gnome-extensions not found; using zip" >&2
rm -f "${OUT}"
(
    cd "${UUID_DIR}"
    zip -r "${OUT}" . \
        -x 'gschemas.compiled' \
        -x 'schemas/gschemas.compiled' \
        -x '*~' \
        -x '*.swp'
)
echo "[INFO] created ${OUT}"
unzip -l "${OUT}"

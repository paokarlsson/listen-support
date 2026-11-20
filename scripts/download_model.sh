#!/usr/bin/env bash
# Laddar ner en ggml-modell till models/.
#
#   ./scripts/download_model.sh base       # whisper.cpp base   (~150 MB)
#   ./scripts/download_model.sh small      # whisper.cpp small  (~490 MB)
#   ./scripts/download_model.sh kb-base    # KB-Whisper base, bättre svenska
#   ./scripts/download_model.sh kb-small   # KB-Whisper small, bäst svenska av dessa
#
# Kontrollera filnamnet i config.toml (transcriber.model_path) efteråt.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

name="${1:-base}"
case "$name" in
  tiny|base|small|medium)
    url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin"
    out="models/ggml-${name}.bin" ;;
  kb-base|kb-small|kb-medium)
    size="${name#kb-}"
    # KBLab publicerar ggml-filer i sina kb-whisper-repon. Om filnamnet har
    # ändrats: se https://huggingface.co/KBLab/kb-whisper-${size}/tree/main
    url="https://huggingface.co/KBLab/kb-whisper-${size}/resolve/main/ggml-model-q5_0.bin"
    out="models/kb-whisper-${size}-q5_0.bin" ;;
  *)
    echo "Okänd modell: $name (välj tiny, base, small, medium, kb-base, kb-small, kb-medium)" >&2
    exit 1 ;;
esac

if [ -f "$out" ]; then
  echo "$out finns redan."
  exit 0
fi

echo "Laddar ner $url"
curl -L --fail --progress-bar -o "$out.part" "$url"
mv "$out.part" "$out"
echo
echo "Klart: $out"
echo "Sätt i config.toml:  model_path = \"$out\""

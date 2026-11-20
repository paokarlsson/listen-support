#!/usr/bin/env bash
# Laddar ner en ggml-modell till models/.
#
#   ./scripts/download_model.sh            # = kb-base (standard)
#   ./scripts/download_model.sh kb-base    # KB-Whisper base: bra svenska, liten och snabb (standard)
#   ./scripts/download_model.sh kb-small   # KB-Whisper small: ännu bättre svenska, tyngre
#   ./scripts/download_model.sh base       # whisper.cpp base (flerspråkig, sämre svenska)
#   ./scripts/download_model.sh small      # whisper.cpp small
#
# KB-Whisper sparas alltid som models/kb-whisper-<storlek>.bin, oavsett vilken
# variant som fanns i KBLabs repo, så att config.toml inte behöver ändras.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

name="${1:-kb-base}"
repo="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
case "$name" in
  tiny|base|small|medium)
    urls=("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin")
    out="models/ggml-${name}.bin" ;;
  kb-tiny|kb-base|kb-small|kb-medium)
    size="${name#kb-}"
    repo="https://huggingface.co/KBLab/kb-whisper-${size}/resolve/main"
    # KBLab publicerar whisper.cpp-filer i sina repon. Filnamnet har inte gått att
    # verifiera härifrån, så vi provar de troliga i tur och ordning.
    urls=("$repo/ggml-model-q5_0.bin" "$repo/ggml-model.bin" "$repo/ggml-model-q8_0.bin")
    out="models/kb-whisper-${size}.bin" ;;
  *)
    echo "Okänd modell: $name (välj kb-base, kb-small, kb-medium, kb-tiny, tiny, base, small, medium)" >&2
    exit 1 ;;
esac

if [ -f "$out" ]; then
  echo "$out finns redan."
  exit 0
fi

for url in "${urls[@]}"; do
  echo "Försöker $url"
  if curl -L --fail --progress-bar -o "$out.part" "$url"; then
    mv "$out.part" "$out"
    echo
    echo "Klart: $out"
    [ "$out" = "models/kb-whisper-base.bin" ] || echo "Sätt i config.toml:  model_path = \"$out\""
    exit 0
  fi
  rm -f "$out.part"
done

echo >&2
echo "Hittade ingen ggml-fil. Kolla filnamnen på ${repo%/resolve/main}/tree/main," >&2
echo "ladda ner whisper.cpp-filen för hand och spara den som $out." >&2
exit 1

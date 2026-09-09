#!/bin/bash
# Download pretrained AASIST and RawNet2 checkpoints
# If auto-download fails, see backend/README.md for manual steps
set -e
CHECKPOINT_DIR="$(dirname "$0")/../checkpoints"
mkdir -p "$CHECKPOINT_DIR"
echo "Checking checkpoints dir: $CHECKPOINT_DIR"

# AASIST official: https://github.com/clovaai/aasist
echo "Attempting AASIST checkpoint..."
if [ ! -f "$CHECKPOINT_DIR/aasist.pth" ]; then
  echo "AASIST: Trying to fetch from GitHub releases..."
  # Example URL - user should verify latest release asset
  # wget -O "$CHECKPOINT_DIR/aasist.pth" https://github.com/clovaai/aasist/releases/download/v1.0/aasist.pth || echo "AASIST auto-download failed - manual download required. See README."
  echo "AASIST: Auto-download URL not pinned - please download manually from https://github.com/clovaai/aasist and place as checkpoints/aasist.pth"
else
  echo "AASIST checkpoint already exists"
fi

# RawNet2 official: https://github.com/asvspoof-challenge/2021
echo "Attempting RawNet2 checkpoint..."
if [ ! -f "$CHECKPOINT_DIR/rawnet2.pth" ]; then
  echo "RawNet2: Trying to fetch..."
  # wget -O "$CHECKPOINT_DIR/rawnet2.pth" https://github.com/asvspoof-challenge/2021/releases/download/v1.0/rawnet2.pth || echo "RawNet2 auto-download failed"
  echo "RawNet2: Please download manually from ASVspoof2021 repo and place as checkpoints/rawnet2.pth"
else
  echo "RawNet2 checkpoint already exists"
fi

# XLS-R via HuggingFace (no manual download needed, cached by transformers)
echo "XLS-R: Will be auto-downloaded by transformers on first run if XLSR_USE_HF=true"
echo "  Model: facebook/wav2vec2-xls-r-300m"
echo "  To enable HF: export XLSR_USE_HF=true"

echo "Done. If checkpoints missing, system will run in heuristic fallback mode (see README Known Limitations)."

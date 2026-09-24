"""Fetch the reranker's weights into `./models/`, once.

Run this before starting the service:

    ./.venv/Scripts/python.exe fetch_model.py

A second model can be fetched by naming its repo, and it lands beside the first:

    ./.venv/Scripts/python.exe fetch_model.py BAAI/bge-reranker-v2-m3

That argument exists so that trying another model is a *fetch*, not a code edit:
the point of the L3 experiment (plan of 2026-09-21) is that the weights are the
only thing that changed, and a fetch script that had to be rewritten to do it
would be one more difference between the two runs.

**It goes through `hf-mirror.com`, and that is not a preference.** On this box
`huggingface.co` does not answer at all — measured 2026-09-21, `curl` exits
without a response code — while `hf-mirror.com` answers 200. `HF_ENDPOINT` is
set to the mirror *before* `huggingface_hub` is imported, because the library
reads it at import and a later assignment would silently fetch from the endpoint
that does not work.

The download is ~1.1 GB for the default model and it is the one slow step in
setting this service up; `app.py` loads from `./models/` afterwards and never
touches the network again.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MIRROR = "https://hf-mirror.com"
DEFAULT_REPO_ID = "BAAI/bge-reranker-base"

# The repo to fetch, and where it lands: `models/<its last path segment>`.
#
# Both are overridable from the command line so that a second model can be tried
# without touching this file — see the module docstring. The default is the model
# the service has always used, so a bare `fetch_model.py` still means the same
# thing it did before.
REPO_ID = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REPO_ID
TARGET = Path(__file__).resolve().parent / "models" / REPO_ID.split("/")[-1]

# Before the import below, and that ordering is the whole reason this file is
# four statements longer than it looks like it needs to be.
os.environ.setdefault("HF_ENDPOINT", MIRROR)

# **And this one is not a preference either.** Measured 2026-09-21: with the
# default transfer backend the mirror serves every config and tokenizer file and
# then fails the weights with `401 Unauthorized` from
# `cas-server.xethub.hf.co` — the Xet CAS server, which the mirror does not
# proxy. The result is a directory that looks like a model (config.json,
# tokenizer_config.json, a 5 MB sentencepiece model) and is 4.9 MB of the ~1.1 GB
# it should be, which `from_pretrained` reports as a missing weight file rather
# than as a failed download. Forcing the classic LFS path keeps the whole fetch
# on the mirror's own CDN.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

# What a completed download looks like: the weights, under either name a repo may
# ship them. Checking the directory for *anything* was the bug that let the
# failed run above report success — the download had left four files behind.
WEIGHT_FILES = ("model.safetensors", "pytorch_model.bin")


def main() -> int:
    if any((TARGET / name).is_file() for name in WEIGHT_FILES):
        print(f"already present: {TARGET}")
        print("delete the directory to fetch it again.")
        return 0

    from huggingface_hub import snapshot_download

    print(f"fetching {REPO_ID} from {os.environ['HF_ENDPOINT']}")
    print(f"  -> {TARGET}")

    snapshot_download(
        repo_id=REPO_ID,
        local_dir=str(TARGET),
        # Weights and tokenizer, and nothing else: the ONNX export and the
        # OpenVINO IR are several hundred megabytes this service never reads.
        #
        # Both weight formats are listed because BAAI ships this one as the older
        # `pytorch_model.bin` while newer repos ship `model.safetensors`, and a
        # pattern list that named only one would download a directory that
        # `from_pretrained` then refuses to load.
        allow_patterns=["*.json", "*.txt", "*.model", "*.safetensors", "*.bin"],
    )

    # Both formats are fetched because either may be the only one a repo ships,
    # and BAAI happens to ship both — a gigabyte each, of which `from_pretrained`
    # reads one. The safetensors copy is the one it prefers, so the other is
    # deleted rather than left as a decoy for whoever next wonders which file is
    # live.
    if (TARGET / "model.safetensors").is_file() and (TARGET / "pytorch_model.bin").is_file():
        (TARGET / "pytorch_model.bin").unlink()
        print("removed pytorch_model.bin (model.safetensors is the copy that gets loaded)")

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

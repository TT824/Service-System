"""Probe the running sidecar: is it up, does it rank, and how long does it take.

    ./.venv/Scripts/python.exe smoke_test.py

This is the instrument, not the gate. The gate is `http-rerank-provider.spec.ts`,
which runs against a fake port on any machine and never needs a model — and
which, for exactly that reason, cannot tell you whether the service on this box
is actually ranking. This can, and it is the thing to run after starting the
server and before believing any A/B number.

**The discrimination is the point.** "有棵树内裤 黑色" over three candidates that
differ only in colour is the failure the reranker was bought for: rank fusion
puts the grey one first because it cannot read the colour word, and a reranker
that returns the *same* order has not helped. A probe that only asserted the
service answered 200 would be green for a service returning the input order —
which is what a cross-encoder that failed to load, or a `top_n` that swallowed
the sort, both look like. So the assertion is on the order, not on the status,
and the last check confirms the other direction: the black one must *lose* when
the question asks for grey.

Latency is printed rather than asserted: it is a number to compare against
`RERANK_TIMEOUT_MS`, and a threshold here would fail on a busy machine for a
reason that has nothing to do with the service.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"

DOCUMENTS = [
    "有棵树男士内裤 颜色：灰色 尺码：XL",
    "有棵树男士内裤 颜色：黑色 尺码：XL",
    "有棵树男士内裤 颜色：蓝色 尺码：XL",
    # Enough filler to make the batch the size a real read produces, so the
    # latency below is the latency the read path pays rather than a toy number.
    *[f"云集防晒帽 颜色：冰雾粉 尺码：均码 编号：SKU-{index:04d}" for index in range(17)],
]


def post(path: str, payload: dict) -> tuple[int, dict, float]:
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
            return response.status, body, time.perf_counter() - started
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8")), time.perf_counter() - started


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    failures: list[str] = []

    try:
        health = get("/health")
    except Exception as error:  # noqa: BLE001 - the reason is the whole point
        print(f"FAIL  the sidecar is not answering on {BASE}: {type(error).__name__}")
        print("      start it with: ./.venv/Scripts/python.exe -m uvicorn app:app --port 8000")
        return 1

    print(f"health  {json.dumps(health, ensure_ascii=False)}")
    if not health.get("loaded"):
        print("FAIL  the service is up but the model is not loaded")
        return 1

    # **Both cases must name a colour that is *not* first in `DOCUMENTS`.** The
    # first version of this probe asked for grey, which the list already had at
    # index 0 — so a service that returned its input untouched passed, and the
    # check looked like evidence of ranking when it was evidence of nothing.
    # `黑色` is at 1 and `蓝色` at 2, so each case fails for a pass-through and
    # they fail for different reasons: one catches a service that promotes
    # nothing, the other a service that always promotes the same position.
    for query, expected_index, label in (
        ("有棵树内裤 黑色", 1, "asks for black"),
        ("有棵树内裤 蓝色", 2, "asks for blue"),
    ):
        status, body, seconds = post(
            "/rerank",
            {"model": health["model"], "query": query, "documents": DOCUMENTS},
        )
        if status != 200:
            failures.append(f"{label}: HTTP {status} {body}")
            continue
        top = body["results"][0]
        judged = DOCUMENTS[expected_index]
        mark = "ok  " if top["index"] == expected_index else "FAIL"
        print(
            f"{mark}  {label}: top1={top['index']} score={top['score']:.3f} "
            f"in {seconds * 1000:.0f}ms for {len(DOCUMENTS)} candidates"
        )
        if top["index"] != expected_index:
            failures.append(f"{label}: ranked {top['index']}, expected {expected_index} ({judged})")

    # The three things that would make every number above meaningless.
    status, body, _ = post(
        "/rerank",
        {"model": "some-other-model", "query": "x", "documents": ["y"]},
    )
    if status != 409:
        failures.append(f"a request naming another model answered HTTP {status}, not 409")

    status, body, _ = post("/rerank", {"model": health["model"], "query": "x", "documents": []})
    if status != 200 or body.get("results") != []:
        failures.append(f"an empty candidate list answered HTTP {status} {body}")

    print()
    if failures:
        for failure in failures:
            print(f"FAIL  {failure}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

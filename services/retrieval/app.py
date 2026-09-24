"""The retrieval sidecar: a cross-encoder reranker behind an HTTP endpoint.

The suggestion path recalls slices with two cheap legs and fuses them by
reciprocal rank — which reads only *where* each leg put a slice, never whether
the slice actually answers the question. Nothing in that design reads the
question and the slice together, so a query naming a colour is answered with the
same product in a different colour whenever the other colour ranks well. This
process is the thing that reads them together: `bge-reranker-base`, a
cross-encoder, scores each (query, slice) pair in one forward pass.

**It is a separate process because it is a different runtime.** It is the only
Python in the repository, and it holds the only model that has to be resident to
answer a read. The API reaches it over HTTP exactly the way it reaches Ollama:
through a provider port, with a configuration that may name no service at all.

**CPU, and deliberately.** The model is 278M parameters and one query reranks a
couple of dozen candidates; this box has no GPU to give it, and the whole point
of the endpoint is that it answers in the time an agent is waiting. `torch` is
installed from PyTorch's CPU index for that reason — a CUDA wheel would be four
times the download to reach the same device.

**Three rules are the Node provider's, restated here because this is where they
can be broken:**

  * **The model name is echoed back, and a request naming another model is
    refused.** The caller configured a name; if this process loaded a different
    one, every score it returns describes a model the caller did not ask for.
    That is the same failure the embedding provider guards against, and it is
    worth guarding here even though nothing is stored: a silently wrong ranker
    is indistinguishable from a ranker that is simply not helping.
  * **Document text is never echoed.** A slice is a tenant's own content — a
    product specification, a FAQ answer, a sentence from a conversation. It goes
    in and nothing of it comes back out: not on a validation error, not on an
    inference failure, not in a log line.
  * **Scores are raw logits and their *order* is the contract.** Nothing here
    applies a sigmoid: the transform is monotone, so it cannot change a ranking,
    and a caller that wanted a probability would be reading a number this model
    was never calibrated to produce. The ordering is what the caller fuses.

Endpoints (`/health`, `/rerank`) are documented in `README.md`; the request and
response shapes are the pydantic models below, which are the contract.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Iterator

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

# ---------------------------------------------------------------- configuration
#
# Read once at import, so every value here is fixed for the life of the process
# and `/health` cannot report something a later request would not honour.

MODEL_PATH = os.environ.get("RERANK_MODEL_PATH", "./models/bge-reranker-base")
MODEL_NAME = os.environ.get("RERANK_MODEL_NAME", "bge-reranker-base")
MAX_LENGTH = int(os.environ.get("RERANK_MAX_LENGTH", "512"))
MAX_DOCUMENTS = int(os.environ.get("RERANK_MAX_DOCUMENTS", "64"))

# One forward pass over a fixed candidate set, guarded by a lock rather than
# left to the threadpool: a reranker that is being reloaded while a request is
# mid-forward would answer with a half-swapped model, and the cost of the lock
# is nothing at the request rate this endpoint serves.
_lock = threading.Lock()

_state: dict[str, object] = {
    "tokenizer": None,
    "model": None,
    "loaded_at": None,
    "load_error": None,
    "load_seconds": None,
}


def load_model() -> None:
    """Load the cross-encoder into memory, or record why it could not be.

    A failure is recorded rather than raised: `/health` has to be able to say
    *what* is wrong, and a process that died at import would leave the caller
    with a connection refused and no reason — the same "absence is not a
    reason" distinction the Node providers draw.
    """
    started = time.monotonic()
    try:
        tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
        model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
        model.eval()
        _state["tokenizer"] = tokenizer
        _state["model"] = model
        _state["loaded_at"] = time.time()
        _state["load_error"] = None
        _state["load_seconds"] = round(time.monotonic() - started, 3)
    except Exception as error:  # noqa: BLE001 - the reason is the whole point
        _state["tokenizer"] = None
        _state["model"] = None
        _state["load_error"] = f"{type(error).__name__}: {error}"


@asynccontextmanager
async def lifespan(_: FastAPI) -> Iterator[None]:
    """Load the model before the first request, so `/health` is honest at once."""
    load_model()
    yield
    _state["model"] = None
    _state["tokenizer"] = None


app = FastAPI(
    title="kefu retrieval sidecar",
    version="1.0.0",
    lifespan=lifespan,
    # The docs pages describe a service that only ever talks to the API on
    # localhost; leaving them on costs nothing and makes the endpoint shapes
    # inspectable without reading this file.
)


# ---------------------------------------------------------------------- shapes


class RerankRequest(BaseModel):
    """One rerank: the question, the candidate texts, and how many to answer with."""

    query: str = Field(description="The buyer's question, verbatim.")
    documents: list[str] = Field(
        description="Candidate slice texts, in the order the caller ranked them.",
    )
    top_n: int | None = Field(
        default=None,
        ge=1,
        description="How many results to return. Omit for all of them.",
    )
    model: str | None = Field(
        default=None,
        description=(
            "The model the caller believes it is talking to. Refused when it "
            "names a different one — see the module note."
        ),
    )


class RerankResult(BaseModel):
    """One document's score, addressed by its position in the request."""

    index: int = Field(description="Index into the request's `documents`.")
    score: float = Field(description="Raw cross-encoder logit; higher is more relevant.")


class RerankResponse(BaseModel):
    """The reranked documents, best first."""

    model: str
    results: list[RerankResult]


class HealthResponse(BaseModel):
    """What this process is, and whether it can answer."""

    status: str
    model: str
    model_path: str
    loaded: bool
    load_seconds: float | None
    load_error: str | None
    device: str
    max_length: int
    max_documents: int


# -------------------------------------------------------------------- handlers


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Report readiness without touching the model.

    `status` is `ok` only when the model is resident: a health check that
    answered `ok` for a process that cannot rerank would make the caller's own
    degradation logic unreachable.
    """
    loaded = _state["model"] is not None
    return HealthResponse(
        status="ok" if loaded else "unavailable",
        model=MODEL_NAME,
        model_path=MODEL_PATH,
        loaded=loaded,
        load_seconds=_state["load_seconds"],  # type: ignore[arg-type]
        load_error=_state["load_error"],  # type: ignore[arg-type]
        device="cpu",
        max_length=MAX_LENGTH,
        max_documents=MAX_DOCUMENTS,
    )


@app.post("/rerank", response_model=RerankResponse)
def rerank(request: RerankRequest) -> RerankResponse:
    """Score every (query, document) pair and return them best first.

    Synchronous on purpose: FastAPI runs a `def` handler in its threadpool, and
    the forward pass is CPU work that would otherwise block the event loop for
    every other request in flight.

    The response is *every* document the caller sent (unless `top_n` narrows it),
    ranked — not a filtered list. A caller reranking twenty candidates to keep
    five needs to see where its sixth-place candidate landed, and "the model
    disliked all of them" is a fact the caller should be able to read rather
    than infer from an empty list.
    """
    if request.model is not None and request.model != MODEL_NAME:
        return _refusal(
            409,
            "rerank_model_mismatch",
            f"this service loaded {MODEL_NAME}; the request names {request.model}",
        )

    model = _state["model"]
    tokenizer = _state["tokenizer"]
    if model is None or tokenizer is None:
        return _refusal(
            503,
            "rerank_model_unavailable",
            f"the model {MODEL_NAME} is not loaded: {_state['load_error']}",
        )

    if len(request.documents) > MAX_DOCUMENTS:
        return _refusal(
            413,
            "rerank_too_many_documents",
            f"{len(request.documents)} documents were sent; this service reranks at most {MAX_DOCUMENTS}",
        )

    if not request.documents:
        # A question with nothing to rerank is answered, not refused: the caller
        # sent no candidates, and an empty ranking is what that means.
        return RerankResponse(model=MODEL_NAME, results=[])

    scores = _score(model, tokenizer, request.query, request.documents)

    # Best first, ties by the caller's own order. The tie-break matters for the
    # same reason it does in the fusion kernel: equal scores are common when a
    # query matches several near-identical specifications, and without it the
    # "top five" would depend on the sort's stability rather than on a decision.
    ranked = sorted(range(len(scores)), key=lambda index: (-scores[index], index))

    if request.top_n is not None:
        ranked = ranked[: request.top_n]

    return RerankResponse(
        model=MODEL_NAME,
        results=[RerankResult(index=index, score=float(scores[index])) for index in ranked],
    )


def _score(
    model: torch.nn.Module,
    tokenizer: object,
    query: str,
    documents: list[str],
) -> list[float]:
    """Run one forward pass over every pair, under the lock.

    One batch rather than a loop: the pairs are the same length after padding, so
    a loop would pay the tokenizer's fixed cost N times to reach the same
    arithmetic.

    `torch.inference_mode` rather than `no_grad`: neither the graph nor the
    version counter is needed, and this is a read path that will be called far
    more often than the model changes.
    """
    with _lock, torch.inference_mode():
        features = tokenizer(  # type: ignore[operator]
            [[query, document] for document in documents],
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        logits = model(**features).logits
        return logits.view(-1).float().tolist()


def _refusal(status: int, code: str, reason: str) -> JSONResponse:
    """A refusal the caller can classify, carrying no document text.

    FastAPI's own validation errors are left alone; this is for the refusals
    this module decides on, where the code is the part the caller switches on and
    the reason is the part an operator reads.
    """
    return JSONResponse(status_code=status, content={"code": code, "reason": reason})


@app.exception_handler(Exception)
async def unhandled(_: Request, error: Exception) -> JSONResponse:
    """Answer 500 with the exception's *type*, never its message.

    A transformers or torch exception can quote the input it was given, and the
    input is a tenant's slice text. The type alone is what an operator needs to
    start looking.
    """
    return JSONResponse(
        status_code=500,
        content={"code": "rerank_internal_error", "reason": type(error).__name__},
    )

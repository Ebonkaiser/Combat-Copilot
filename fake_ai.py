"""Deterministic, offline stand-ins for the AI services -- tests and CI only.

Never copied into the Docker image (see the Dockerfile's explicit COPY list and
.dockerignore), so production cannot load them.
"""
import hashlib
import math
import re
from typing import Any, Iterator, List, Optional

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from llama_index.core.base.embeddings.base import BaseEmbedding
from pydantic import PrivateAttr


class EchoChatModel(BaseChatModel):
    """Deterministic stand-in for Gemini: it "narrates" by echoing the prompt it was given.

    The combat graph's human message carries the event, the combatants and the retrieved
    lore + rules, so an echo lets a test see exactly what text reached the model -- the
    end-to-end proof of what lore a given caller was allowed to cause to be retrieved.
    Streams in small chunks like the real model does.
    """

    chunk_size: int = 48

    @property
    def _llm_type(self) -> str:
        return "echo-fake"

    @staticmethod
    def _echo(messages: List[BaseMessage]) -> str:
        content = messages[-1].content if messages else ""
        return f"[fake narration] {content if isinstance(content, str) else content!s}"

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self._echo(messages)))])

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        text = self._echo(messages)
        for start in range(0, len(text), self.chunk_size):
            yield ChatGenerationChunk(message=AIMessageChunk(content=text[start : start + self.chunk_size]))


class HashingEmbedding(BaseEmbedding):
    """Bag-of-words feature hashing: no network, no API key, stable across runs.

    Texts that share words land near each other, so a query that names a
    document's distinctive words retrieves that document. That is enough to
    test retrieval *scoping* (who may see which text); it makes no claim about
    semantic quality -- the live tests cover that with real embeddings.
    """

    dims: int = 256
    _batch_sizes: List[int] = PrivateAttr(default_factory=list)

    @classmethod
    def class_name(cls) -> str:
        return "HashingEmbedding"

    @property
    def batch_sizes(self) -> List[int]:
        """Size of every text-embedding batch requested so far (one entry per API-call equivalent)."""
        return self._batch_sizes

    def _embed(self, text: str) -> List[float]:
        vector = [0.0] * self.dims
        for token in re.findall(r"[a-z0-9_]+", text.lower()):
            digest = int.from_bytes(hashlib.sha256(token.encode("utf-8")).digest()[:8], "big")
            vector[digest % self.dims] += 1.0 if (digest >> 63) & 1 else -1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def _get_query_embedding(self, query: str) -> List[float]:
        return self._embed(query)

    async def _aget_query_embedding(self, query: str) -> List[float]:
        return self._embed(query)

    def _get_text_embedding(self, text: str) -> List[float]:
        return self._embed(text)

    def _get_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        self._batch_sizes.append(len(texts))
        return [self._embed(text) for text in texts]

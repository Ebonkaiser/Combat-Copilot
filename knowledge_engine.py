"""Campaign-scoped knowledge base: SRD rules + per-campaign lore on LlamaIndex + Chroma.

Every stored chunk carries a ``campaign_id``: ``"srd"`` for the public rules, the
campaign slug for that campaign's lore. Every retrieval filters on it, and there
is deliberately no unfiltered query path -- Chroma treats an empty filter as "no
filter at all", so the privacy of campaign lore rests on never building one.

Content is *synced* from disk rather than appended: documents are keyed by
``sha256(campaign_id + relative_path + content)``, so a restart adds nothing,
an edited file is re-embedded, and a deleted file's vectors are removed.
"""
import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

import chromadb
import yaml
from llama_index.core import Document, StorageContext, VectorStoreIndex
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.ingestion import run_transformations
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.vector_stores import FilterOperator, MetadataFilter, MetadataFilters
from llama_index.embeddings.google_genai import GoogleGenAIEmbedding
from llama_index.vector_stores.chroma import ChromaVectorStore

from campaigns import RULES_CAMPAIGN_ID, is_valid_campaign_id

logger = logging.getLogger("combat_copilot.knowledge")

# v2: every chunk carries campaign_id. The original "ttrpg_knowledge" collection
# is left untouched (never read, never deleted) so rolling back to the previous
# image still finds the data its ingestion flags say is there.
DEFAULT_COLLECTION = "ttrpg_knowledge_v2"

_TEXT_SUFFIXES = {".md", ".txt"}
_FRONTMATTER = re.compile(r"^---\n(.*?)\n---[ \t]*(?:\n|$)(.*)", re.DOTALL)
_DELETE_BATCH = 500


@dataclass(frozen=True)
class SyncResult:
    """Outcome of one sync, counted in documents (files). An edited file is one removal plus one addition."""

    added: int
    removed: int
    unchanged: int


class CombatKnowledgeBase:
    def __init__(
        self,
        persist_dir: str = "./chroma_db",
        collection_name: str = DEFAULT_COLLECTION,
        embed_model: Optional[BaseEmbedding] = None,
    ):
        self.persist_dir = persist_dir
        self.collection_name = collection_name

        # Passed explicitly to the index instead of through llama-index's global
        # Settings, so tests can inject an offline embedder without global state.
        self.embed_model = (
            embed_model if embed_model is not None else GoogleGenAIEmbedding(model_name="gemini-embedding-001")
        )
        self._splitter = SentenceSplitter()

        self.chroma_client = chromadb.PersistentClient(path=self.persist_dir)
        self.chroma_collection = self.chroma_client.get_or_create_collection(self.collection_name)
        self.vector_store = ChromaVectorStore(chroma_collection=self.chroma_collection)
        self.storage_context = StorageContext.from_defaults(vector_store=self.vector_store)
        self.index = VectorStoreIndex.from_vector_store(
            self.vector_store,
            storage_context=self.storage_context,
            embed_model=self.embed_model,
        )

    # ------------------------------------------------------------------ sync

    @staticmethod
    def extract_yaml_frontmatter(text: str) -> tuple[dict, str]:
        """Extracts YAML frontmatter and returns metadata dict and cleaned text.

        Only a block that parses as a YAML mapping counts as frontmatter. A
        document that merely opens with a horizontal rule (``---``) keeps its
        full text instead of losing everything before the next rule.
        """
        match = _FRONTMATTER.match(text)
        if not match:
            return {}, text
        try:
            metadata = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            return {}, text
        if metadata is None:  # an empty ---/--- block
            metadata = {}
        if isinstance(metadata, dict):
            return metadata, match.group(2).strip()
        return {}, text

    @staticmethod
    def _check_namespace(campaign_id: str) -> None:
        if campaign_id != RULES_CAMPAIGN_ID and not is_valid_campaign_id(campaign_id):
            raise ValueError(f"Invalid campaign id: {campaign_id!r}")

    @staticmethod
    def _document_id(campaign_id: str, relative_path: str, text: str) -> str:
        payload = f"{campaign_id}\x00{relative_path}\x00{text}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def _read_documents(self, input_dir: Path, campaign_id: str) -> Dict[str, Document]:
        """Reads every .md/.txt file under input_dir into Documents keyed by their content-hash id."""
        default_category = "rules" if campaign_id == RULES_CAMPAIGN_ID else "lore"
        documents: Dict[str, Document] = {}
        if not input_dir.is_dir():
            return documents

        for path in sorted(input_dir.rglob("*")):
            relative = path.relative_to(input_dir)
            if not path.is_file() or path.suffix.lower() not in _TEXT_SUFFIXES:
                continue
            if any(part.startswith(".") for part in relative.parts):
                continue  # editor/OS metadata such as .obsidian/ or .DS_Store

            # utf-8-sig: Windows editors may prepend a BOM, which would hide the
            # frontmatter. Normalised newlines keep a CRLF checkout (or rsync from
            # Windows) from changing the hash or defeating the frontmatter regex.
            text = path.read_bytes().decode("utf-8-sig", errors="replace")
            text = text.replace("\r\n", "\n").replace("\r", "\n")
            relative_posix = relative.as_posix()

            frontmatter, body = self.extract_yaml_frontmatter(text)
            if not body.strip():
                continue

            metadata: Dict[str, str] = {"category": default_category}
            for key, value in frontmatter.items():
                # Chroma metadata must be flat primitives: lists become comma-separated strings.
                if isinstance(value, list):
                    metadata[str(key)] = ", ".join(str(item) for item in value)
                elif value is not None:
                    metadata[str(key)] = str(value)
            # Forced AFTER the frontmatter merge: a file cannot claim another campaign's namespace.
            metadata["source_path"] = relative_posix
            metadata["campaign_id"] = campaign_id

            doc_id = self._document_id(campaign_id, relative_posix, text)
            documents[doc_id] = Document(
                text=body,
                metadata=metadata,
                id_=doc_id,
                excluded_embed_metadata_keys=["campaign_id"],
                excluded_llm_metadata_keys=["campaign_id"],
            )
        return documents

    def _stored_document_ids(self, campaign_id: str) -> Set[str]:
        stored = self.chroma_collection.get(where={"campaign_id": campaign_id}, include=["metadatas"])
        return {
            metadata["document_id"]
            for metadata in (stored["metadatas"] or [])
            if metadata and metadata.get("document_id")
        }

    def sync_directory(self, input_dir: str, campaign_id: str) -> SyncResult:
        """Makes the stored documents of ``campaign_id`` match the files under ``input_dir``.

        New or changed files are embedded in one batched insert (a handful of
        embedding calls, not one per file). Files that are gone, or whose
        content changed, have their old vectors removed. A missing directory
        means "no documents": the namespace is emptied.
        """
        self._check_namespace(campaign_id)
        desired = self._read_documents(Path(input_dir), campaign_id)
        stored = self._stored_document_ids(campaign_id)

        to_add = [doc for doc_id, doc in desired.items() if doc_id not in stored]
        to_remove = sorted(stored - desired.keys())

        # Insert before deleting: if an embedding call fails, the namespace is
        # left no emptier than it was.
        if to_add:
            nodes = run_transformations(to_add, [self._splitter], show_progress=False)
            self.index.insert_nodes(nodes)
        for ref_doc_id in to_remove:
            self.vector_store.delete(ref_doc_id)

        return SyncResult(added=len(to_add), removed=len(to_remove), unchanged=len(desired) - len(to_add))

    def sync_rules(self, input_dir: str) -> SyncResult:
        """Syncs the public SRD rules (namespace ``srd``)."""
        return self.sync_directory(input_dir, RULES_CAMPAIGN_ID)

    def sync_campaign(self, lore_dir: str, campaign_id: str) -> SyncResult:
        """Syncs one campaign's private lore. Refuses the reserved ``srd`` namespace."""
        if not is_valid_campaign_id(campaign_id):
            raise ValueError(f"Invalid campaign id: {campaign_id!r}")
        return self.sync_directory(lore_dir, campaign_id)

    def purge_campaigns_except(self, keep: Iterable[str]) -> List[str]:
        """Deletes stored chunks whose campaign is not in ``keep`` (the SRD rules always stay).

        Keeps a campaign that was removed from disk from lingering in the
        vector store. Returns the namespaces that were purged.
        """
        keep_ids = set(keep) | {RULES_CAMPAIGN_ID}
        stored = self.chroma_collection.get(include=["metadatas"])
        doomed: List[str] = []
        purged: Set[str] = set()
        for chunk_id, metadata in zip(stored["ids"], stored["metadatas"] or []):
            campaign_id = (metadata or {}).get("campaign_id")
            if campaign_id not in keep_ids:
                doomed.append(chunk_id)
                purged.add(campaign_id or "(unscoped)")
        for start in range(0, len(doomed), _DELETE_BATCH):
            self.chroma_collection.delete(ids=doomed[start : start + _DELETE_BATCH])
        return sorted(purged)

    def count(self) -> int:
        """Number of stored chunks across all namespaces."""
        return self.chroma_collection.count()

    # ------------------------------------------------------------- retrieval

    def _retrieve(self, query: str, campaign_id: str, faction: Optional[str], top_k: int) -> str:
        """Top-k chunks from exactly one namespace (optionally narrowed to one faction)."""
        filters = [MetadataFilter(key="campaign_id", value=campaign_id, operator=FilterOperator.EQ)]
        if faction:
            filters.append(MetadataFilter(key="faction", value=faction, operator=FilterOperator.EQ))

        retriever = self.index.as_retriever(similarity_top_k=top_k, filters=MetadataFilters(filters=filters))
        nodes = retriever.retrieve(query)

        # Defense in depth: the filter above is what scopes the query, but text
        # from another namespace must never be returned even if the vector
        # store were ever to ignore it.
        in_scope = [node for node in nodes if node.node.metadata.get("campaign_id") == campaign_id]
        if len(in_scope) != len(nodes):
            logger.error(
                "Vector store returned %d chunk(s) outside namespace %r; dropped them.",
                len(nodes) - len(in_scope),
                campaign_id,
            )
        return "\n\n".join(node.node.get_content() for node in in_scope)

    def retrieve_rules(self, query: str, top_k: int = 2) -> str:
        """Public SRD rules only."""
        return self._retrieve(query, RULES_CAMPAIGN_ID, None, top_k)

    def retrieve_campaign_lore(
        self, query: str, campaign_id: str, faction: Optional[str] = None, top_k: int = 2
    ) -> str:
        """One campaign's private lore. Raises on an empty or reserved campaign_id: callers must decide
        explicitly that a lookup is allowed, so a missing id can never fall through to "search everything"."""
        if not is_valid_campaign_id(campaign_id):
            raise ValueError(f"campaign_id is required for lore retrieval, got {campaign_id!r}")
        return self._retrieve(query, campaign_id, faction, top_k)

    def retrieve_context(
        self, query: str, campaign_id: Optional[str], faction: Optional[str] = None, top_k: int = 2
    ) -> str:
        """SRD rules first, then -- only when ``campaign_id`` is set -- that campaign's lore.

        ``campaign_id=None`` (anonymous) never touches campaign lore: a
        server-side guarantee, not a UI one.
        """
        parts = [self.retrieve_rules(query, top_k=top_k)]
        if campaign_id is not None:
            parts.append(self.retrieve_campaign_lore(query, campaign_id, faction=faction, top_k=top_k))
        return "\n\n".join(part for part in parts if part)

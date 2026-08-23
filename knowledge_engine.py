import os
import yaml
import re
from typing import List, Optional, Dict, Any
import chromadb
from llama_index.core import (
    VectorStoreIndex,
    SimpleDirectoryReader,
    StorageContext,
    Document,
    Settings,
)
from llama_index.core.vector_stores import MetadataFilters, ExactMatchFilter
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.google_genai import GoogleGenAIEmbedding


class CombatKnowledgeBase:
    def __init__(self, persist_dir: str = "./chroma_db", collection_name: str = "ttrpg_knowledge"):
        self.persist_dir = persist_dir
        self.collection_name = collection_name
        
        # Configure embedding engine
        Settings.embed_model = GoogleGenAIEmbedding(model_name="gemini-embedding-001")
        
        # Initialize Persistent ChromaDB
        self.chroma_client = chromadb.PersistentClient(path=self.persist_dir)
        self.chroma_collection = self.chroma_client.get_or_create_collection(self.collection_name)
        self.vector_store = ChromaVectorStore(chroma_collection=self.chroma_collection)
        self.storage_context = StorageContext.from_defaults(vector_store=self.vector_store)
        
        self.index = VectorStoreIndex.from_vector_store(
            self.vector_store,
            storage_context=self.storage_context
        )

    def extract_yaml_frontmatter(self, text: str) -> tuple[dict, str]:
        """Extracts YAML frontmatter and returns metadata dict and cleaned text."""
        match = re.match(r"^---\n(.*?)\n---\n(.*)", text, re.DOTALL)
        if match:
            try:
                metadata = yaml.safe_load(match.group(1))
                return metadata if isinstance(metadata, dict) else {}, match.group(2).strip()
            except yaml.YAMLError:
                return {}, text
        return {}, text

    def ingest_directory(self, input_dir: str, category: str) -> int:
        """Loads markdown documents, assigns structured metadata, and inserts them into the Chroma index."""
        if not os.path.exists(input_dir):
            return 0

        reader = SimpleDirectoryReader(input_dir=input_dir, required_exts=[".md", ".txt"], recursive=True)
        raw_docs = reader.load_data()

        count = 0
        for doc in raw_docs:
            doc.metadata["category"] = category
            
            # Extract YAML Frontmatter
            frontmatter, clean_text = self.extract_yaml_frontmatter(doc.text)
            
            # Update metadata, converting lists to comma-separated strings for ChromaDB compatibility
            for k, v in frontmatter.items():
                if isinstance(v, list):
                    doc.metadata[k] = ", ".join(str(i) for i in v)
                elif v is not None:
                    doc.metadata[k] = str(v)
                    
            doc.set_content(clean_text)

            # Insert document into the existing VectorStoreIndex & ChromaDB
            self.index.insert(doc)
            count += 1

        return count

    def retrieve_context(self, query: str, metadata_filters: Optional[Dict[str, Any]] = None, top_k: int = 2) -> str:
        """Retrieves matching context with optional exact-match metadata filtering."""
        filters = None
        if metadata_filters:
            exact_filters = [
                ExactMatchFilter(key=k, value=v) for k, v in metadata_filters.items()
            ]
            if exact_filters:
                filters = MetadataFilters(filters=exact_filters)

        retriever = self.index.as_retriever(
            similarity_top_k=top_k,
            filters=filters
        )
        nodes = retriever.retrieve(query)
        return "\n\n".join([n.node.get_content() for n in nodes])
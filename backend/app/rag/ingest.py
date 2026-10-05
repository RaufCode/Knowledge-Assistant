from llama_index.core import SimpleDirectoryReader, VectorStoreIndex
from llama_index.core.node_parser import MarkdownNodeParser
from llama_index.embeddings.nvidia import NVIDIAEmbedding

from app.config import settings

# Metadata we keep for citations but don't want polluting the embeddings/LLM text
NOISE = ["file_path", "file_type", "file_size", "creation_date", "last_modified_date"]


def build_index() -> VectorStoreIndex:
    docs = SimpleDirectoryReader(
        settings.data_dir, required_exts=[".md"]
    ).load_data()

    # Policy title = the first "# " heading of each file
    for d in docs:
        first_line = d.text.strip().splitlines()[0]
        d.metadata["policy_title"] = first_line.lstrip("# ").strip()

    # One chunk per markdown section
    nodes = MarkdownNodeParser().get_nodes_from_documents(docs)

    for n in nodes:
        header_path = n.metadata.get("header_path", "/").strip("/")
        n.metadata["section"] = header_path.split("/")[-1] if header_path else "Overview"
        n.excluded_embed_metadata_keys = NOISE + ["file_name"]
        n.excluded_llm_metadata_keys = NOISE

    # The retrieval key, kept separate from the generation key so embedding traffic
    # has its own quota. The index is rebuilt on every start, so a changed
    # embedding model takes effect on the next boot with no migration.
    embed = NVIDIAEmbedding(
        model=settings.embed_model, api_key=settings.nvidia_embedding_api_key
    )
    return VectorStoreIndex(nodes, embed_model=embed)

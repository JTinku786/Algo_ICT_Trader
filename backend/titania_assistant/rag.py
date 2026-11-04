"""Local, source-citable RAG index over approved Titania documentation roots."""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from pypdf import PdfReader

from .config import settings

_EXTENSIONS = {".pdf", ".md", ".txt", ".ipynb"}
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", ".pytest_cache"}
_CHUNK_CHARS = 1600
_CHUNK_OVERLAP = 220
_MAX_FILE_BYTES = 50 * 1024 * 1024
_MAX_PDF_PAGES = 500


@dataclass(frozen=True)
class RagChunk:
    path: str
    page: int | None
    content: str
    score: float


def _connect(path: str | Path | None = None) -> sqlite3.Connection:
    db_path = Path(path or settings.rag_db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS titania_rag_chunks "
        "USING fts5(content, path UNINDEXED, page UNINDEXED)"
    )
    return connection


def _iter_files(roots: tuple[str, ...]) -> Iterator[Path]:
    seen: set[str] = set()
    for raw_root in roots:
        root = Path(raw_root)
        if not root.is_dir():
            continue
        for directory, dirs, files in os.walk(root):
            dirs[:] = [name for name in dirs if name not in _SKIP_DIRS]
            for name in files:
                path = Path(directory, name)
                if path.suffix.lower() not in _EXTENSIONS:
                    continue
                # Downloads is user-owned mixed storage. Only index explicitly
                # strategy/trading-named material from that root; never ingest
                # unrelated personal documents just because they share a folder.
                if root.name.lower() == "downloads":
                    searchable_name = str(path).lower()
                    if not any(keyword in searchable_name for keyword in settings.rag_download_keywords):
                        continue
                try:
                    if path.stat().st_size > _MAX_FILE_BYTES:
                        continue
                except OSError:
                    continue
                resolved = str(path.resolve())
                if resolved not in seen:
                    seen.add(resolved)
                    yield path


def _read_document(path: Path) -> list[tuple[int | None, str]]:
    try:
        if path.suffix.lower() == ".pdf":
            reader = PdfReader(str(path))
            return [
                (index + 1, page.extract_text() or "")
                for index, page in enumerate(reader.pages[:_MAX_PDF_PAGES])
            ]
        if path.suffix.lower() == ".ipynb":
            notebook = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
            text = "\n".join(
                "".join(cell.get("source") or [])
                for cell in notebook.get("cells", [])
                if cell.get("cell_type") == "markdown"
            )
            return [(None, text)]
        return [(None, path.read_text(encoding="utf-8", errors="ignore")[:2_000_000])]
    except Exception:
        return []


def _chunks(text: str) -> Iterator[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    for start in range(0, len(normalized), _CHUNK_CHARS - _CHUNK_OVERLAP):
        chunk = normalized[start : start + _CHUNK_CHARS].strip()
        if len(chunk) >= 80:
            yield chunk
        if start + _CHUNK_CHARS >= len(normalized):
            break


def rebuild_index(
    roots: tuple[str, ...] | None = None,
    db_path: str | Path | None = None,
    *,
    clear: bool = True,
    max_files: int | None = None,
) -> dict[str, int]:
    """Rebuild the local FTS index. Intended for an explicit operator job."""
    configured_roots = roots or settings.rag_roots
    connection = _connect(db_path)
    try:
        if clear:
            connection.execute("DELETE FROM titania_rag_chunks")
        documents = chunks = skipped = 0
        for path in _iter_files(configured_roots):
            if documents >= (max_files or settings.rag_max_files):
                break
            pages = _read_document(path)
            if not pages:
                skipped += 1
                continue
            documents += 1
            for page, text in pages:
                for chunk in _chunks(text):
                    connection.execute(
                        "INSERT INTO titania_rag_chunks(content, path, page) VALUES (?, ?, ?)",
                        (chunk, str(path.resolve()), page),
                    )
                    chunks += 1
        connection.commit()
        return {"documents": documents, "chunks": chunks, "skipped": skipped}
    finally:
        connection.close()


def append_files(files: tuple[str, ...], db_path: str | Path | None = None) -> dict[str, int]:
    """Append explicitly selected approved documents without recursively scanning a mixed folder."""
    connection = _connect(db_path)
    try:
        documents = chunks = skipped = 0
        for raw_path in files:
            path = Path(raw_path)
            try:
                if not path.is_file() or path.suffix.lower() not in _EXTENSIONS or path.stat().st_size > _MAX_FILE_BYTES:
                    skipped += 1
                    continue
            except OSError:
                skipped += 1
                continue
            pages = _read_document(path)
            if not pages:
                skipped += 1
                continue
            documents += 1
            for page, text in pages:
                for chunk in _chunks(text):
                    connection.execute(
                        "INSERT INTO titania_rag_chunks(content, path, page) VALUES (?, ?, ?)",
                        (chunk, str(path.resolve()), page),
                    )
                    chunks += 1
        connection.commit()
        return {"documents": documents, "chunks": chunks, "skipped": skipped}
    finally:
        connection.close()


def retrieve(query: str, top_k: int | None = None, db_path: str | Path | None = None) -> list[RagChunk]:
    """Retrieve compact, source-citable snippets from the existing local index."""
    if not settings.rag_enabled or not query:
        return []
    db = Path(db_path or settings.rag_db_path)
    if not db.exists():
        return []
    terms = re.findall(r"[A-Za-z0-9]{2,}", query.lower())[:14]
    if not terms:
        return []
    fts_query = " OR ".join(terms)
    try:
        connection = _connect(db)
        try:
            rows = connection.execute(
                "SELECT path, page, content, bm25(titania_rag_chunks) AS score "
                "FROM titania_rag_chunks WHERE titania_rag_chunks MATCH ? "
                "ORDER BY score LIMIT ?",
                (fts_query, top_k or settings.rag_top_k),
            ).fetchall()
            return [RagChunk(path=row["path"], page=row["page"], content=row["content"], score=row["score"]) for row in rows]
        finally:
            connection.close()
    except sqlite3.Error:
        return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Titania's approved-document RAG index")
    parser.add_argument("--rebuild", action="store_true", help="rebuild the local index")
    parser.add_argument("--append", action="store_true", help="append roots to the existing index")
    parser.add_argument("--roots", nargs="+", help="specific approved roots to index")
    parser.add_argument("--files", nargs="+", help="explicit approved document files to append")
    parser.add_argument("--max-files", type=int, help="bound this build invocation")
    args = parser.parse_args()
    if not args.rebuild:
        parser.error("use --rebuild")
    if args.files:
        print(json.dumps(append_files(tuple(args.files)), indent=2))
        return
    roots = tuple(args.roots) if args.roots else None
    print(json.dumps(rebuild_index(roots=roots, clear=not args.append, max_files=args.max_files), indent=2))


if __name__ == "__main__":
    main()

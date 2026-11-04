from pathlib import Path

from backend.titania_assistant.rag import append_files, rebuild_index, retrieve


def test_rag_rebuild_and_retrieve(tmp_path: Path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "strategy.md").write_text(
        "S03 uses breaker-block confirmation and a Fair Value Gap. "
        "The setup needs structure confirmation before entry and avoids weak signals.",
        encoding="utf-8",
    )
    db = tmp_path / "rag.db"
    result = rebuild_index(roots=(str(docs),), db_path=db)
    matches = retrieve("Explain S03 Fair Value Gap", db_path=db)
    assert result["documents"] == 1
    assert result["chunks"] == 1
    assert matches and matches[0].path.endswith("strategy.md")


def test_rag_can_append_explicit_document(tmp_path: Path):
    source = tmp_path / "S03_strategy.txt"
    source.write_text(
        "S03 breaker block requires displacement and Fair Value Gap confirmation. "
        "A setup is rejected when the confirmation is weak or the liquidity target is unclear.",
        encoding="utf-8",
    )
    db = tmp_path / "rag.db"
    result = append_files((str(source),), db_path=db)
    assert result["documents"] == 1
    assert retrieve("S03 breaker block", db_path=db)

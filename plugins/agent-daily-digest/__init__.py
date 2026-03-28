"""agent-daily-digest — fuses all of yesterday's source documents into one daily summary.

Runs after all source plugins (default cron: 0 22 * * *).  Queries every
document dated yesterday, loads full text from vault, then asks LLM to
synthesise a concise Chinese daily digest.  Falls back to plain-text when
LLM is unavailable.
"""

from datetime import date, timedelta
from typing import Any, Dict, List

from pios.sdk import AgentPlugin


class Plugin(AgentPlugin):
    """Daily digest agent — one consolidated summary per day."""

    async def run(self) -> Dict[str, Any]:
        self.logger.info("agent-daily-digest: starting")

        days_offset = int(self.context.get_config("days_offset", 1))
        target_date = (date.today() - timedelta(days=days_offset)).isoformat()
        self.logger.info(f"Generating digest for {target_date}")

        # Skip if already generated
        if self.context.database:
            existing = self.context.database.get_documents(
                source="agent-daily-digest-output",
                date_from=target_date,
                date_to=target_date,
            )
            if existing:
                self.logger.info(f"Digest already exists for {target_date}, skipping")
                return {"status": "skipped", "date": target_date}

        # Collect all source documents for target_date
        all_docs: List[Dict] = []
        if self.context.database:
            all_docs = self.context.database.get_documents(
                date_from=target_date,
                date_to=target_date,
                limit=50,
            )
        # Exclude previous agent outputs
        all_docs = [d for d in all_docs if not d.get("source", "").startswith("agent-")]

        if not all_docs:
            self.logger.info(f"No source documents found for {target_date}")
            return {"status": "success", "items_included": 0, "date": target_date}

        # Load full text content from vault (max 3 docs × 3000 chars per source)
        source_texts: Dict[str, str] = {}
        if self.context.document_store:
            by_source: Dict[str, List[Dict]] = {}
            for doc in all_docs:
                by_source.setdefault(doc.get("source", "unknown"), []).append(doc)

            for src, docs in by_source.items():
                chunks: List[str] = []
                for doc in docs[:3]:
                    full = self.context.document_store.get(doc["id"])
                    if full and full.content.get("text"):
                        chunks.append(full.content["text"][:3000])
                if chunks:
                    source_texts[src] = "\n\n".join(chunks)

        self.logger.info(
            f"Loaded content from {len(source_texts)} sources: {list(source_texts.keys())}"
        )

        # Generate digest
        if self.context.is_llm_available() and source_texts:
            digest = self._llm_digest(target_date, source_texts)
        else:
            digest = self._plain_digest(target_date, source_texts)

        # Save
        doc_id = self.save_document(
            title=f"每日摘要 {target_date}",
            content=digest,
            doc_type="daily-digest",
            tags=["digest", "daily", "agent"],
        )

        self.logger.info(f"Saved daily digest {doc_id} for {target_date}")
        return {
            "status": "success",
            "date": target_date,
            "items_included": len(all_docs),
            "sources": list(source_texts.keys()),
            "digest_id": doc_id,
        }

    # ------------------------------------------------------------------ helpers

    def _llm_digest(self, date_str: str, source_texts: Dict[str, str]) -> str:
        sections = [f"### {src}\n{text[:2500]}" for src, text in source_texts.items()]
        context_block = "\n\n".join(sections)

        prompt = f"""你是用户的私人助理，负责生成每日生活综合摘要。
以下是 {date_str} 从各数据源收集的内容（可能包含健康数据、微信聊天、AI 对话、照片日记等）：

{context_block[:9000]}

请生成一份简洁的每日综合摘要，仅输出以下格式（用中文，精炼），没有对应数据的章节请省略：

# 每日摘要 {date_str}

## 今日一句话
<用一句话概括今天最重要/最有意义的事>  ^daily-summary

## 今日要事
- <来自各来源的重要事件/对话/活动，3-6条，每条一行>

## 健康状态
<如有健康数据，一段话描述今日健康状况及异常>

## 社交与沟通
<如有微信数据，一段话描述今日重要交流与待办>

## AI 使用
<如有 ChatGPT/Claude 数据，一段话描述今日 AI 对话主题>

## 照片回顾
<如有照片数据，一段话描述今日拍摄内容与地点>

---
只生成内容，不要解释思考过程。"""

        try:
            messages = [{"role": "user", "content": prompt}]
            return self.context.llm.complete(messages, temperature=0.3, max_tokens=2000)
        except Exception as e:
            self.logger.error(f"LLM digest failed: {e}")
            return self._plain_digest(date_str, source_texts)

    def _plain_digest(self, date_str: str, source_texts: Dict[str, str]) -> str:
        lines = [f"# 每日摘要 {date_str}", "（LLM 不可用，以下为原始内容摘录）", ""]
        for src, text in source_texts.items():
            lines.append(f"## {src}")
            lines.append(text[:600])
            lines.append("")
        return "\n".join(lines)

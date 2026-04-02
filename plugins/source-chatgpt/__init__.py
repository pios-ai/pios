"""source-chatgpt — parses ChatGPT export JSON and produces a daily digest.

Data source: ChatGPT Settings → Data Controls → Export data → conversations.json

The export format is a JSON array of conversations:
[
  {
    "id": "...",
    "title": "...",
    "create_time": 1234567890.0,
    "update_time": 1234567890.0,
    "mapping": {
      "<node_id>": {
        "message": {
          "author": {"role": "user"|"assistant"|"system"},
          "content": {"content_type": "text", "parts": ["..."]},
          "create_time": 1234567890.0
        }
      }
    }
  }
]

This plugin:
1. Loads conversations.json
2. Filters conversations that had activity on the target date
3. Extracts the message thread in order
4. Uses LLM (if available) to generate a structured daily digest
"""

import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pios.sdk import SourcePlugin, SourceData


def _load_export(export_file: str) -> List[Dict]:
    """Load conversations.json. Returns list of conversation dicts."""
    path = Path(export_file).expanduser()
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    # Some exports wrap in {"conversations": [...]}
    return data.get("conversations", [])


def _extract_messages(conv: Dict) -> List[Tuple[str, str, float]]:
    """Extract (role, text, timestamp) tuples in chronological order."""
    mapping = conv.get("mapping") or {}
    nodes = list(mapping.values())
    nodes.sort(key=lambda n: (n.get("message") or {}).get("create_time") or 0)

    messages = []
    for node in nodes:
        msg = node.get("message")
        if not msg:
            continue
        role = (msg.get("author") or {}).get("role", "")
        if role not in ("user", "assistant"):
            continue
        content_obj = msg.get("content") or {}
        parts = content_obj.get("parts") or []
        text = " ".join(str(p) for p in parts if isinstance(p, str) and p.strip())
        if not text:
            continue
        ts = msg.get("create_time") or 0
        messages.append((role, text, ts))
    return messages


def _conv_active_on(conv: Dict, target_date: str) -> bool:
    """Check if a conversation had any messages on target_date."""
    mapping = conv.get("mapping") or {}
    for node in mapping.values():
        msg = node.get("message")
        if not msg:
            continue
        ts = msg.get("create_time")
        if ts and datetime.fromtimestamp(ts).strftime("%Y-%m-%d") == target_date:
            return True
    return False


def _build_raw_text(target_date: str, conversations: List[Dict]) -> str:
    """Build raw text listing all conversations active on target_date."""
    lines = [f"# ChatGPT 对话记录 {target_date}", ""]
    for conv in conversations:
        title = conv.get("title") or "无标题"
        messages = _extract_messages(conv)
        # Filter to messages on target_date
        day_msgs = [
            (role, text, ts) for role, text, ts in messages
            if datetime.fromtimestamp(ts).strftime("%Y-%m-%d") == target_date
        ]
        if not day_msgs:
            continue
        lines.append(f"## {title}")
        for role, text, ts in day_msgs:
            label = "用户" if role == "user" else "ChatGPT"
            # Truncate very long messages
            preview = text[:500] + ("…" if len(text) > 500 else "")
            lines.append(f"**{label}**: {preview}")
        lines.append("")
    return "\n".join(lines)


def _llm_summary(raw_text: str, target_date: str, llm: Any) -> str:
    prompt = f"""你是用户的私人助理，负责整理他的 AI 对话日记。
以下是 {target_date} 的 ChatGPT/Claude 对话记录（按话题分组）：

{raw_text[:6000]}

请生成一份结构化的对话日记，格式如下（用中文，精炼）：

# ChatGPT日记 {target_date}

## ChatGPT今日内容一句话总结
<一句话总结今天所有 AI 对话的核心主题> ^chatgpt-daily-summary

## 核心话题 Top 5
- <话题名>
  - <关键内容1-2句>

## 讨论主题 Top 10
- <次要话题，一行一个>

## 边缘内容
- <零散、简短、不重要的话题>

---
只生成内容，不要解释思考过程。"""
    try:
        messages = [{"role": "user", "content": prompt}]
        return llm.complete(messages, temperature=0.3, max_tokens=2000)
    except Exception as e:
        return f"（LLM 摘要生成失败: {e}）\n\n{raw_text}"


class Plugin(SourcePlugin):
    """ChatGPT daily digest source plugin — parses export JSON."""

    def fetch(self) -> List[SourceData]:
        export_file = self.context.get_config("export_file", "")
        days_back = int(self.context.get_config("days_back", 1))

        if not export_file:
            self.logger.warning(
                "source-chatgpt: set export_file to conversations.json path "
                "(ChatGPT → Settings → Data Controls → Export)"
            )
            return []

        export_file = str(Path(export_file).expanduser())
        conversations = _load_export(export_file)
        if not conversations:
            self.logger.warning(f"No conversations found in {export_file}")
            return []

        self.logger.info(f"Loaded {len(conversations)} conversations from export")
        results: List[SourceData] = []
        today = date.today()

        for i in range(1, days_back + 1):
            target = (today - timedelta(days=i)).isoformat()

            if self.context.database:
                existing = self.context.database.get_documents(
                    source="source-chatgpt", date_from=target, date_to=target
                )
                if existing:
                    self.logger.info(f"Skipping {target} — already in vault")
                    continue

            active = [c for c in conversations if _conv_active_on(c, target)]
            if not active:
                self.logger.info(f"No ChatGPT conversations on {target}")
                continue

            self.logger.info(f"Found {len(active)} conversations active on {target}")
            results.append(SourceData(
                source="source-chatgpt",
                data_type="chatgpt-daily",
                content={"date": target, "conversations": active},
                title=f"ChatGPT日记 {target}",
                date=target,
                tags=["chatgpt", "ai", "daily"],
            ))

        return results

    def normalize(self, data: SourceData) -> Dict[str, Any]:
        target_date = data.content["date"]
        conversations = data.content["conversations"]
        raw_text = _build_raw_text(target_date, conversations)

        llm = self.context.llm
        if llm and llm.is_available():
            self.logger.info(f"Generating LLM summary for {target_date}...")
            summary = _llm_summary(raw_text, target_date, llm)
        else:
            self.logger.info("LLM not available — saving raw conversation log")
            summary = raw_text

        return {"text": summary}

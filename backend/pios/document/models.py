"""Document data models."""

from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Dict, List, Optional
import json
import yaml


@dataclass
class Document:
    """Document model with frontmatter support."""

    doc_id: str
    source: str
    data_type: str
    content: Dict[str, Any]
    title: Optional[str] = None
    date: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    file_path: Optional[str] = None
    content_hash: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Document":
        """Create Document from dictionary."""
        return cls(
            doc_id=data.get("doc_id", ""),
            source=data.get("source", ""),
            data_type=data.get("data_type", ""),
            content=data.get("content", {}),
            title=data.get("title"),
            date=data.get("date"),
            tags=data.get("tags", []),
            file_path=data.get("file_path"),
            content_hash=data.get("content_hash"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    def to_markdown_with_frontmatter(self) -> str:
        """Convert to Markdown with YAML frontmatter.

        Returns:
            Markdown string with YAML frontmatter header
        """
        # Create frontmatter
        frontmatter = {
            "id": self.doc_id,
            "source": self.source,
            "type": self.data_type,
            "title": self.title,
            "date": self.date,
            "tags": self.tags,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

        # Remove None values
        frontmatter = {k: v for k, v in frontmatter.items() if v is not None}

        # Create markdown content
        markdown_lines = [
            "---",
            yaml.dump(frontmatter, default_flow_style=False, sort_keys=False),
            "---",
            "",
        ]

        # Add content
        body = ""
        if isinstance(self.content, dict):
            if "text" in self.content:
                body = self.content["text"]
            else:
                body = "```json\n" + json.dumps(self.content, indent=2) + "\n```"
        else:
            body = str(self.content)

        # Add title heading only if body doesn't already start with one
        if self.title and not body.lstrip().startswith("#"):
            markdown_lines.append(f"# {self.title}\n")

        markdown_lines.append(body)
        return "\n".join(markdown_lines)

    @classmethod
    def from_markdown_with_frontmatter(cls, markdown: str) -> "Document":
        """Parse Markdown with YAML frontmatter.

        Args:
            markdown: Markdown string with frontmatter

        Returns:
            Document instance
        """
        import re

        # Extract frontmatter
        frontmatter_match = re.match(r"^---\n(.*?)\n---\n(.*)", markdown, re.DOTALL)

        if not frontmatter_match:
            raise ValueError("Invalid markdown format, missing frontmatter")

        frontmatter_str = frontmatter_match.group(1)
        content_str = frontmatter_match.group(2).strip()

        # Parse YAML frontmatter
        frontmatter = yaml.safe_load(frontmatter_str) or {}

        # Extract content
        content = {"text": content_str}

        return cls(
            doc_id=frontmatter.get("id", ""),
            source=frontmatter.get("source", ""),
            data_type=frontmatter.get("type", ""),
            title=frontmatter.get("title"),
            date=frontmatter.get("date"),
            tags=frontmatter.get("tags", []),
            content=content,
            created_at=frontmatter.get("created_at"),
            updated_at=frontmatter.get("updated_at"),
        )

    def compute_hash(self) -> str:
        """Compute hash of document content.

        Returns:
            SHA256 hash of content
        """
        import hashlib
        content_str = json.dumps(self.content, sort_keys=True)
        return hashlib.sha256(content_str.encode()).hexdigest()

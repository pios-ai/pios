"""Document API routes."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/api/documents", tags=["documents"])


class DocumentInfo(BaseModel):
    """Document information."""

    doc_id: str
    source: str
    type: str
    title: Optional[str] = None
    date: Optional[str] = None
    tags: List[str] = []
    created_at: str


class DocumentListResponse(BaseModel):
    """List of documents."""

    total: int
    documents: List[DocumentInfo]


@router.get("/", response_model=DocumentListResponse)
async def list_documents(
    source: Optional[str] = Query(None),
    doc_type: Optional[str] = Query(None),
    limit: int = Query(100),
    offset: int = Query(0),
    database=None,
):
    """List documents from vault."""
    if not database:
        raise HTTPException(status_code=500, detail="Database not available")

    docs = database.get_documents(
        source=source,
        doc_type=doc_type,
        limit=limit + 1,
        offset=offset,
    )

    # Check if there are more results
    has_more = len(docs) > limit
    if has_more:
        docs = docs[:limit]

    doc_infos = [
        DocumentInfo(
            doc_id=doc["id"],
            source=doc["source"],
            type=doc["type"],
            title=doc["title"],
            date=doc["date"],
            tags=doc["tags"].split(",") if doc["tags"] else [],
            created_at=doc["created_at"],
        )
        for doc in docs
    ]

    return DocumentListResponse(
        total=len(doc_infos),
        documents=doc_infos,
    )


@router.get("/{doc_id}")
async def get_document(doc_id: str, document_store=None):
    """Get a document."""
    if not document_store:
        raise HTTPException(status_code=500, detail="Document store not available")

    doc = document_store.get(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document {doc_id} not found")

    return {
        "id": doc.doc_id,
        "source": doc.source,
        "type": doc.data_type,
        "title": doc.title,
        "date": doc.date,
        "tags": doc.tags,
        "content": doc.content,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
    }


@router.get("/search/query")
async def search_documents(
    q: str = Query(..., min_length=1),
    limit: int = Query(50),
    document_store=None,
):
    """Search documents."""
    if not document_store:
        raise HTTPException(status_code=500, detail="Document store not available")

    results = document_store.search(q, limit=limit)

    return {
        "query": q,
        "total": len(results),
        "results": [
            {
                "id": doc.doc_id,
                "source": doc.source,
                "type": doc.data_type,
                "title": doc.title,
                "date": doc.date,
            }
            for doc in results
        ],
    }


@router.get("/stats")
async def get_document_stats(database=None, document_store=None):
    """Get document vault statistics."""
    db_stats = {}
    vault_stats = {}

    if database:
        db_stats = database.get_stats()

    if document_store:
        vault_stats = document_store.get_stats()

    return {
        "database": db_stats,
        "vault": vault_stats,
    }

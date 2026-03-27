import React, { useEffect, useState } from 'react'
import { listDocuments, searchDocuments, getDocumentStats } from '../lib/api'

export default function Documents() {
  const [documents, setDocuments] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterSource, setFilterSource] = useState('')

  useEffect(() => {
    const loadDocuments = async () => {
      try {
        setLoading(true)
        const [docsRes, statsRes] = await Promise.all([
          listDocuments(filterSource || undefined, undefined, 100),
          getDocumentStats(),
        ])
        setDocuments(docsRes.data.documents || [])
        setStats(statsRes.data)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    loadDocuments()
  }, [filterSource])

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim()) return

    try {
      setLoading(true)
      const res = await searchDocuments(searchQuery)
      setDocuments(res.data.results || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const sources = [...new Set(documents.map((d) => d.source))]

  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Documents</h1>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-gray-600 text-sm font-medium mb-2">Total Documents</h3>
            <div className="text-3xl font-bold">{stats.database?.total_documents || 0}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-gray-600 text-sm font-medium mb-2">Sources</h3>
            <div className="text-3xl font-bold">{stats.database?.total_sources || 0}</div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-gray-600 text-sm font-medium mb-2">Document Types</h3>
            <div className="text-3xl font-bold">{stats.database?.total_documents ? '...' : 0}</div>
          </div>
        </div>
      )}

      {/* Search and Filter */}
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <form onSubmit={handleSearch} className="flex gap-4 mb-4">
          <input
            type="text"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2 rounded-lg transition-colors"
          >
            Search
          </button>
        </form>

        {sources.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilterSource('')}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                !filterSource
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
              }`}
            >
              All Sources
            </button>
            {sources.map((source) => (
              <button
                key={source}
                onClick={() => setFilterSource(source)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                  filterSource === source
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                {source}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Documents List */}
      {loading ? (
        <div className="text-center py-8">Loading documents...</div>
      ) : documents.length > 0 ? (
        <div className="space-y-4">
          {documents.map((doc) => (
            <div
              key={doc.doc_id}
              className="bg-white rounded-lg shadow p-6 hover:shadow-lg transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-lg font-bold">{doc.title || 'Untitled'}</h3>
                  <div className="flex gap-2 mt-1">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {doc.source}
                    </span>
                    <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">
                      {doc.type}
                    </span>
                  </div>
                </div>
                {doc.date && (
                  <span className="text-sm text-gray-500">
                    {new Date(doc.date).toLocaleDateString()}
                  </span>
                )}
              </div>

              {doc.tags && doc.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {doc.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-sm text-gray-600">
                Created: {new Date(doc.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-gray-600">No documents found.</p>
        </div>
      )}
    </div>
  )
}

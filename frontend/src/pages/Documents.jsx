import React, { useEffect, useState, useCallback } from 'react'
import {
  listDocuments,
  searchDocuments,
  getDocumentStats,
  getDocument,
  getDocumentCalendar,
} from '../lib/api'

// ── Simple Markdown → HTML renderer (no external deps) ────────────────────────
function renderMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // headings
    .replace(/^###### (.+)$/gm, '<h6 class="text-sm font-bold mt-3 mb-1">$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5 class="text-sm font-bold mt-3 mb-1">$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4 class="text-base font-bold mt-4 mb-1">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-bold mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-5 mb-2 text-gray-900">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-2 mb-3 text-gray-900">$1</h1>')
    // horizontal rule
    .replace(/^---+$/gm, '<hr class="my-4 border-gray-200"/>')
    // bold / italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 rounded text-sm font-mono">$1</code>')
    // markdown table header separator (skip rendering it)
    .replace(/^\|[\s|:-]+\|$/gm, '')
    // markdown table rows
    .replace(/^\|(.+)\|$/gm, (_, cells) => {
      const tds = cells
        .split('|')
        .map((c) => `<td class="border border-gray-200 px-2 py-1 text-sm">${c.trim()}</td>`)
        .join('')
      return `<tr>${tds}</tr>`
    })
    // bullet lists
    .replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    // wrap consecutive <li> in <ul>
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, (m) => `<ul class="space-y-0.5 my-2">${m}</ul>`)
    // wrap consecutive <tr> in <table>
    .replace(/(<tr>.*<\/tr>\n?)+/g, (m) => `<table class="border-collapse w-full my-3">${m}</table>`)
    // paragraphs: lines not already tagged
    .replace(/^(?!<[a-z]).+$/gm, (line) =>
      line.trim() ? `<p class="text-sm text-gray-700 my-1">${line}</p>` : ''
    )
}

// ── Document viewer drawer ─────────────────────────────────────────────────────
function DocViewer({ docId, onClose }) {
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDocument(docId)
      .then((res) => setDoc(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [docId])

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-end z-50">
      <div className="bg-white h-full w-full max-w-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-bold truncate">{doc?.title || 'Document'}</h2>
            {doc && (
              <p className="text-xs text-gray-400">
                {doc.source} · {doc.date || '—'}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="ml-4 text-gray-400 hover:text-gray-600 text-2xl flex-shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <p className="text-gray-400">Loading…</p>
          ) : doc ? (
            <>
              {doc.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {doc.tags.map((t) => (
                    <span
                      key={t}
                      className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              {doc.content?.text ? (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content.text) }}
                />
              ) : (
                <pre className="text-xs text-gray-600 whitespace-pre-wrap">
                  {JSON.stringify(doc.content, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <p className="text-red-500">Failed to load document.</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Calendar widget ────────────────────────────────────────────────────────────
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function Calendar({ year, month, dayCounts, selectedDate, onSelectDate }) {
  const firstDay = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = []

  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const pad = (n) => String(n).padStart(2, '0')

  return (
    <div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-xs text-gray-400 font-medium py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) => {
          if (!day) return <div key={`empty-${i}`} />
          const dateStr = `${year}-${pad(month)}-${pad(day)}`
          const count = dayCounts[dateStr] || 0
          const isSelected = selectedDate === dateStr
          const isToday = dateStr === new Date().toISOString().slice(0, 10)

          return (
            <button
              key={dateStr}
              onClick={() => onSelectDate(isSelected ? null : dateStr)}
              className={`relative text-center text-sm py-1.5 rounded transition-colors ${
                isSelected
                  ? 'bg-blue-600 text-white font-bold'
                  : isToday
                  ? 'border border-blue-400 text-blue-700 font-medium hover:bg-blue-50'
                  : count > 0
                  ? 'hover:bg-gray-100 text-gray-800 font-medium'
                  : 'text-gray-400 hover:bg-gray-50'
              }`}
            >
              {day}
              {count > 0 && !isSelected && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Documents() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [dayCounts, setDayCounts] = useState({})

  const [documents, setDocuments] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [selectedDate, setSelectedDate] = useState(null)
  const [viewingDocId, setViewingDocId] = useState(null)

  // Load calendar counts
  useEffect(() => {
    getDocumentCalendar(year, month, filterSource || undefined)
      .then((res) => setDayCounts(res.data.days || {}))
      .catch(() => {})
  }, [year, month, filterSource])

  // Load document list
  const loadDocuments = useCallback(async () => {
    try {
      setLoading(true)
      const [docsRes, statsRes] = await Promise.all([
        listDocuments(
          filterSource || undefined,
          undefined,
          100,
          selectedDate || undefined,
          selectedDate || undefined,
        ),
        getDocumentStats(),
      ])
      setDocuments(docsRes.data.documents || [])
      setStats(statsRes.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterSource, selectedDate])

  useEffect(() => { loadDocuments() }, [loadDocuments])

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim()) {
      loadDocuments()
      return
    }
    try {
      setLoading(true)
      const res = await searchDocuments(searchQuery)
      setDocuments(res.data.results || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    loadDocuments()
  }

  // All sources seen across all docs (for filter pills)
  const allSources = [...new Set(documents.map((d) => d.source))].sort()

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12) }
    else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1) }
    else setMonth(m => m + 1)
  }

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  return (
    <div>
      {viewingDocId && (
        <DocViewer docId={viewingDocId} onClose={() => setViewingDocId(null)} />
      )}

      <h1 className="text-3xl font-bold mb-6 text-gray-900">Documents</h1>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {stats.database?.total_documents || 0}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Total documents</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {stats.database?.total_sources || 0}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Sources</div>
          </div>
          <div className="bg-white rounded-lg shadow p-4 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {Object.keys(dayCounts).length}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Days this month</div>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left: calendar + filters */}
        <div className="w-full lg:w-64 flex-shrink-0 space-y-4">
          {/* Calendar */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <button onClick={prevMonth} className="text-gray-500 hover:text-gray-700 text-lg px-1">‹</button>
              <span className="text-sm font-semibold text-gray-800">
                {MONTH_NAMES[month - 1]} {year}
              </span>
              <button onClick={nextMonth} className="text-gray-500 hover:text-gray-700 text-lg px-1">›</button>
            </div>
            <Calendar
              year={year}
              month={month}
              dayCounts={dayCounts}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
            {selectedDate && (
              <button
                onClick={() => setSelectedDate(null)}
                className="mt-2 w-full text-xs text-blue-600 hover:underline"
              >
                Clear date filter ({selectedDate})
              </button>
            )}
          </div>

          {/* Source filter */}
          {allSources.length > 0 && (
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Source</p>
              <div className="space-y-1">
                <button
                  onClick={() => setFilterSource('')}
                  className={`w-full text-left px-2 py-1 rounded text-sm transition-colors ${
                    !filterSource
                      ? 'bg-blue-100 text-blue-800 font-medium'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  All sources
                </button>
                {allSources.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterSource(s)}
                    className={`w-full text-left px-2 py-1 rounded text-sm transition-colors ${
                      filterSource === s
                        ? 'bg-blue-100 text-blue-800 font-medium'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: search + document list */}
        <div className="flex-1 min-w-0">
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2 mb-4">
            <input
              type="text"
              placeholder="Search documents…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Search
            </button>
            {searchQuery && (
              <button
                type="button"
                onClick={clearSearch}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            )}
          </form>

          {/* Document list */}
          {loading ? (
            <div className="text-center py-12 text-gray-400">Loading…</div>
          ) : documents.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
              <p className="text-gray-500">No documents found.</p>
              {selectedDate && (
                <p className="text-sm text-gray-400 mt-1">
                  No documents for {selectedDate}.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc) => (
                <div
                  key={doc.doc_id}
                  onClick={() => setViewingDocId(doc.doc_id)}
                  className="bg-white rounded-lg shadow p-4 cursor-pointer hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900 truncate">
                        {doc.title || 'Untitled'}
                      </h3>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                          {doc.source}
                        </span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                          {doc.type}
                        </span>
                        {doc.tags?.map((t) => (
                          <span
                            key={t}
                            className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {doc.date && (
                        <p className="text-xs text-gray-500">{doc.date}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(doc.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

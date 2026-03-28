import React, { useEffect, useState } from 'react'
import { getSystemStatus, getDocumentStats, listPlugins, listDocuments } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-gray-500 text-sm font-medium mb-1">{label}</h3>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [status, setStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [plugins, setPlugins] = useState([])
  const [todayDocs, setTodayDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        const today = new Date().toISOString().slice(0, 10)
        const [statusRes, statsRes, pluginsRes, docsRes] = await Promise.all([
          getSystemStatus(),
          getDocumentStats(),
          listPlugins(),
          listDocuments(undefined, undefined, 20, today, today),
        ])
        setStatus(statusRes.data)
        setStats(statsRes.data)
        setPlugins(pluginsRes.data || [])
        setTodayDocs(docsRes.data.documents || [])
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>
  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  const activePlugins = plugins.filter((p) => p.enabled).length
  const totalDocs = stats?.database?.total_documents || 0
  const dbOk = status?.database?.status === 'connected'
  const schedulerOk = status?.scheduler?.status === 'running'

  // Recent plugin runs: sort by last_run descending, show those with a last_run
  const recentRuns = [...plugins]
    .filter((p) => p.last_run)
    .sort((a, b) => new Date(b.last_run) - new Date(a.last_run))
    .slice(0, 5)

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8 text-gray-900">Dashboard</h1>

      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="System"
          value={dbOk ? 'Ready' : 'Error'}
          sub={`DB: ${status?.database?.status || '—'}`}
        />
        <StatCard
          label="Documents"
          value={totalDocs}
          sub={`${stats?.database?.total_sources || 0} sources`}
        />
        <StatCard
          label="Active Plugins"
          value={activePlugins}
          sub={`${plugins.length} total`}
        />
        <StatCard
          label="Scheduler"
          value={schedulerOk ? 'Running' : 'Stopped'}
          sub={`${status?.scheduler?.jobs || 0} jobs`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's documents */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-bold mb-4 text-gray-900">
            Today's Documents
            <span className="ml-2 text-sm font-normal text-gray-400">
              {new Date().toLocaleDateString()}
            </span>
          </h2>
          {todayDocs.length === 0 ? (
            <p className="text-gray-400 text-sm">No documents generated today yet.</p>
          ) : (
            <ul className="space-y-3">
              {todayDocs.map((doc) => (
                <li key={doc.doc_id} className="flex items-start gap-3">
                  <span className="mt-0.5 w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {doc.title || 'Untitled'}
                    </p>
                    <p className="text-xs text-gray-400">{doc.source}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent plugin runs */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-bold mb-4 text-gray-900">Recent Plugin Activity</h2>
          {recentRuns.length === 0 ? (
            <p className="text-gray-400 text-sm">No plugin runs recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {recentRuns.map((p) => (
                <li key={p.name} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{p.name}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(p.last_run).toLocaleString()}
                    </p>
                  </div>
                  <StatusBadge
                    status={
                      p.last_run_status === 'success'
                        ? 'healthy'
                        : p.last_run_status === 'failed'
                        ? 'error'
                        : 'idle'
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Vault stats */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-bold mb-4 text-gray-900">Document Vault</h2>
          <dl className="space-y-2">
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Total documents</dt>
              <dd className="text-sm font-semibold text-gray-900">{totalDocs}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Sources</dt>
              <dd className="text-sm font-semibold text-gray-900">
                {stats?.database?.total_sources || 0}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">Vault path</dt>
              <dd className="text-xs text-gray-400 truncate max-w-48">
                {stats?.vault?.vault_path || '—'}
              </dd>
            </div>
          </dl>
        </div>

        {/* System info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-bold mb-4 text-gray-900">System</h2>
          <dl className="space-y-2">
            <div className="flex justify-between items-center">
              <dt className="text-sm text-gray-500">Database</dt>
              <dd>
                <StatusBadge status={dbOk ? 'healthy' : 'error'} />
              </dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-sm text-gray-500">Scheduler</dt>
              <dd>
                <StatusBadge status={schedulerOk ? 'running' : 'stopped'} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">LLM provider</dt>
              <dd className="text-sm text-gray-700">
                {status?.llm?.provider || '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-500">LLM model</dt>
              <dd className="text-sm text-gray-700">
                {status?.llm?.model || '—'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}

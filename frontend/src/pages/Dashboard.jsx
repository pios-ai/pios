import React, { useEffect, useState } from 'react'
import { getSystemStatus, getDocumentStats } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

export default function Dashboard() {
  const [status, setStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadDashboard = async () => {
      try {
        setLoading(true)
        const [statusRes, statsRes] = await Promise.all([
          getSystemStatus(),
          getDocumentStats(),
        ])
        setStatus(statusRes.data)
        setStats(statsRes.data)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    loadDashboard()
    const interval = setInterval(loadDashboard, 5000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <div className="text-center py-8">Loading...</div>
  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      {/* System Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 text-sm font-medium mb-2">System Status</h3>
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold">
              {status?.database?.status === 'connected' ? 'Ready' : 'Error'}
            </span>
            <StatusBadge status="healthy" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 text-sm font-medium mb-2">Database</h3>
          <div className="text-2xl font-bold">{status?.database?.type}</div>
          <p className="text-xs text-gray-500 mt-1">
            Status: {status?.database?.status}
          </p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 text-sm font-medium mb-2">Plugins</h3>
          <div className="text-2xl font-bold">{status?.plugins?.loaded || 0}</div>
          <p className="text-xs text-gray-500 mt-1">Loaded</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-gray-600 text-sm font-medium mb-2">Scheduler</h3>
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold">
              {status?.scheduler?.status}
            </span>
            <StatusBadge status={status?.scheduler?.status} />
          </div>
        </div>
      </div>

      {/* Documents Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-bold mb-4">Document Vault</h3>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Total Documents</span>
                <span className="text-2xl font-bold">
                  {stats.database?.total_documents || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Sources</span>
                <span className="text-xl font-bold">
                  {stats.database?.total_sources || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Vault Location</span>
                <span className="text-sm text-gray-500">
                  {stats.vault?.vault_path || 'Not configured'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-bold mb-4">System Info</h3>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-600">App Name</span>
                <span className="font-medium">{status?.app_name}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Debug Mode</span>
                <StatusBadge status={status?.debug ? 'running' : 'stopped'} />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Last Updated</span>
                <span className="text-sm text-gray-500">Just now</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

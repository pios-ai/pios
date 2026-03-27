import React, { useEffect, useState } from 'react'
import { listPlugins, runPlugin } from '../lib/api'
import StatusBadge from '../components/StatusBadge'

export default function Plugins() {
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState({})

  useEffect(() => {
    const loadPlugins = async () => {
      try {
        setLoading(true)
        const res = await listPlugins()
        setPlugins(res.data)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    loadPlugins()
  }, [])

  const handleRunPlugin = async (pluginName) => {
    try {
      setRunning((prev) => ({ ...prev, [pluginName]: true }))
      await runPlugin(pluginName)
      // Reload plugin list to show updated status
      const res = await listPlugins()
      setPlugins(res.data)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning((prev) => ({ ...prev, [pluginName]: false }))
    }
  }

  if (loading) return <div className="text-center py-8">Loading plugins...</div>
  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  const sourcePlugins = plugins.filter((p) => p.type === 'source')
  const agentPlugins = plugins.filter((p) => p.type === 'agent')

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Plugins</h1>

      {/* Source Plugins */}
      {sourcePlugins.length > 0 && (
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-4">Data Sources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sourcePlugins.map((plugin) => (
              <div key={plugin.name} className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold">{plugin.name}</h3>
                    <p className="text-sm text-gray-600">{plugin.description}</p>
                  </div>
                  <StatusBadge status={plugin.enabled ? 'running' : 'stopped'} />
                </div>
                <div className="text-sm text-gray-500 mb-4">
                  <p>v{plugin.version}</p>
                  {plugin.last_run && (
                    <p className="text-xs">Last run: {new Date(plugin.last_run).toLocaleString()}</p>
                  )}
                </div>
                <button
                  onClick={() => handleRunPlugin(plugin.name)}
                  disabled={running[plugin.name]}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded transition-colors disabled:opacity-50"
                >
                  {running[plugin.name] ? 'Running...' : 'Run Now'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent Plugins */}
      {agentPlugins.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold mb-4">Agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agentPlugins.map((plugin) => (
              <div key={plugin.name} className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold">{plugin.name}</h3>
                    <p className="text-sm text-gray-600">{plugin.description}</p>
                  </div>
                  <StatusBadge status={plugin.enabled ? 'running' : 'stopped'} />
                </div>
                <div className="text-sm text-gray-500 mb-4">
                  <p>v{plugin.version}</p>
                  {plugin.last_run && (
                    <p className="text-xs">Last run: {new Date(plugin.last_run).toLocaleString()}</p>
                  )}
                </div>
                <button
                  onClick={() => handleRunPlugin(plugin.name)}
                  disabled={running[plugin.name]}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2 rounded transition-colors disabled:opacity-50"
                >
                  {running[plugin.name] ? 'Running...' : 'Run Now'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {plugins.length === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <p className="text-yellow-800">No plugins configured.</p>
        </div>
      )}
    </div>
  )
}

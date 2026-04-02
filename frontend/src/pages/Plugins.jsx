import React, { useEffect, useState, useCallback } from 'react'
import {
  listPlugins,
  runPlugin,
  enablePlugin,
  disablePlugin,
  getPluginRuns,
  getPluginConfig,
  configurePlugin,
} from '../lib/api'
import StatusBadge from '../components/StatusBadge'

// ── Config editor modal ────────────────────────────────────────────────────────
function ConfigModal({ plugin, onClose, onSaved }) {
  const [schema, setSchema] = useState({})
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getPluginConfig(plugin.name)
      .then((res) => {
        setSchema(res.data.schema || {})
        setValues(res.data.current || {})
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [plugin.name])

  const handleSave = async () => {
    try {
      setSaving(true)
      await configurePlugin(plugin.name, values)
      onSaved()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold">Configure: {plugin.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="px-6 py-4 max-h-96 overflow-y-auto">
          {loading ? (
            <p className="text-gray-500">Loading config...</p>
          ) : error ? (
            <p className="text-red-500">{error}</p>
          ) : Object.keys(schema).length === 0 ? (
            <p className="text-gray-500">This plugin has no configurable settings.</p>
          ) : (
            <div className="space-y-4">
              {Object.entries(schema).map(([key, meta]) => {
                const desc = typeof meta === 'object' ? meta.description : ''
                const type = typeof meta === 'object' ? meta.type : 'string'
                return (
                  <div key={key}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {key}
                      {desc && <span className="ml-2 text-xs font-normal text-gray-400">{desc}</span>}
                    </label>
                    {type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={!!values[key]}
                        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.checked }))}
                        className="w-4 h-4"
                      />
                    ) : type === 'integer' || type === 'number' ? (
                      <input
                        type="number"
                        value={values[key] ?? ''}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [key]: Number(e.target.value) }))
                        }
                        className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    ) : (
                      <input
                        type="text"
                        value={values[key] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                        className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run history panel ──────────────────────────────────────────────────────────
function RunHistory({ pluginName }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPluginRuns(pluginName, 5)
      .then((res) => setRuns(res.data.runs || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [pluginName])

  if (loading) return <p className="text-xs text-gray-400 mt-2">Loading history…</p>
  if (runs.length === 0) return <p className="text-xs text-gray-400 mt-2">No runs yet.</p>

  return (
    <div className="mt-3 border-t pt-3">
      <p className="text-xs font-medium text-gray-500 mb-2">Recent runs</p>
      <ul className="space-y-1">
        {runs.map((r) => (
          <li key={r.run_id || r.id} className="flex items-center justify-between text-xs">
            <span className="text-gray-500">
              {r.started_at ? new Date(r.started_at).toLocaleString() : '—'}
            </span>
            <span
              className={`font-medium ${
                r.status === 'success'
                  ? 'text-green-600'
                  : r.status === 'failed'
                  ? 'text-red-500'
                  : 'text-gray-400'
              }`}
            >
              {r.status}
              {r.duration_ms ? ` · ${r.duration_ms}ms` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Plugin card ────────────────────────────────────────────────────────────────
function PluginCard({ plugin, accentColor, onRefresh }) {
  const [running, setRunning] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [configPlugin, setConfigPlugin] = useState(null)
  const [error, setError] = useState(null)

  const handleRun = async () => {
    try {
      setRunning(true)
      setError(null)
      await runPlugin(plugin.name)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const handleToggle = async () => {
    try {
      setToggling(true)
      setError(null)
      if (plugin.enabled) {
        await disablePlugin(plugin.name)
      } else {
        await enablePlugin(plugin.name)
      }
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setToggling(false)
    }
  }

  const btn = `bg-${accentColor}-600 hover:bg-${accentColor}-700`

  return (
    <>
      {configPlugin && (
        <ConfigModal
          plugin={configPlugin}
          onClose={() => setConfigPlugin(null)}
          onSaved={onRefresh}
        />
      )}
      <div className="bg-white rounded-lg shadow p-5 flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900 truncate">{plugin.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{plugin.description}</p>
          </div>
          {/* Enable/disable toggle */}
          <button
            onClick={handleToggle}
            disabled={toggling}
            title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
            className={`ml-3 flex-shrink-0 w-10 h-6 rounded-full transition-colors relative ${
              plugin.enabled ? 'bg-green-500' : 'bg-gray-300'
            } ${toggling ? 'opacity-50' : ''}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                plugin.enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Meta */}
        <div className="text-xs text-gray-400 mb-3 space-y-0.5">
          <p>v{plugin.version}</p>
          {plugin.schedule && <p>Schedule: <code className="bg-gray-100 px-1 rounded">{plugin.schedule}</code></p>}
          {plugin.last_run && (
            <p>
              Last run:{' '}
              <span
                className={
                  plugin.last_run_status === 'success'
                    ? 'text-green-600'
                    : plugin.last_run_status === 'failed'
                    ? 'text-red-500'
                    : 'text-gray-500'
                }
              >
                {new Date(plugin.last_run).toLocaleString()}
                {plugin.last_run_status && ` (${plugin.last_run_status})`}
              </span>
            </p>
          )}
          {plugin.next_run && <p>Next: {new Date(plugin.next_run).toLocaleString()}</p>}
        </div>

        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

        {/* Actions */}
        <div className="flex gap-2 mt-auto">
          <button
            onClick={handleRun}
            disabled={running}
            className={`flex-1 ${btn} text-white text-sm font-medium py-1.5 rounded transition-colors disabled:opacity-50`}
          >
            {running ? 'Running…' : 'Run Now'}
          </button>
          <button
            onClick={() => setConfigPlugin(plugin)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors"
            title="Configure"
          >
            ⚙
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={`px-3 py-1.5 text-sm border rounded transition-colors ${
              showHistory
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-gray-300 hover:bg-gray-50'
            }`}
            title="Run history"
          >
            ≡
          </button>
        </div>

        {showHistory && <RunHistory pluginName={plugin.name} />}
      </div>
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Plugins() {
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await listPlugins()
      setPlugins(res.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="text-center py-12 text-gray-500">Loading plugins…</div>
  if (error) return <div className="text-red-600 py-8">Error: {error}</div>

  const sourcePlugins = plugins.filter((p) => p.type === 'source')
  const agentPlugins = plugins.filter((p) => p.type === 'agent')

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8 text-gray-900">Plugins</h1>

      {sourcePlugins.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 text-gray-700">Data Sources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sourcePlugins.map((p) => (
              <PluginCard key={p.name} plugin={p} accentColor="blue" onRefresh={load} />
            ))}
          </div>
        </section>
      )}

      {agentPlugins.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-4 text-gray-700">Agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {agentPlugins.map((p) => (
              <PluginCard key={p.name} plugin={p} accentColor="green" onRefresh={load} />
            ))}
          </div>
        </section>
      )}

      {plugins.length === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <p className="text-yellow-800">No plugins found. Check your plugin directories.</p>
        </div>
      )}
    </div>
  )
}

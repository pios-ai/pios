import axios from 'axios'

const API_BASE = '/api'

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
})

// System endpoints
export const getSystemStatus = () => api.get('/system/status')
export const getHealth = () => api.get('/system/health')
export const getConfig = () => api.get('/system/config')
export const getVersion = () => api.get('/system/version')

// Plugin endpoints
export const listPlugins = () => api.get('/plugins')
export const getPlugin = (name) => api.get(`/plugins/${name}`)
export const runPlugin = (name) => api.post(`/plugins/${name}/run`)
export const enablePlugin = (name) => api.post(`/plugins/${name}/enable`)
export const disablePlugin = (name) => api.post(`/plugins/${name}/disable`)
export const reloadPlugin = (name) => api.post(`/plugins/${name}/reload`)
export const getPluginRuns = (name, limit = 10) =>
  api.get(`/plugins/${name}/runs`, { params: { limit } })
export const getPluginConfig = (name) => api.get(`/plugins/${name}/config`)
export const configurePlugin = (name, config) =>
  api.post(`/plugins/${name}/configure`, config)

// Document endpoints
export const listDocuments = (source, type, limit = 100, dateFrom, dateTo) =>
  api.get('/documents', {
    params: { source, doc_type: type, limit, date_from: dateFrom, date_to: dateTo },
  })
export const getDocument = (id) => api.get(`/documents/${id}`)
export const searchDocuments = (query, limit = 50) =>
  api.get('/documents/search/query', { params: { q: query, limit } })
export const getDocumentStats = () => api.get('/documents/stats')
export const getDocumentCalendar = (year, month, source) =>
  api.get('/documents/calendar', { params: { year, month, source } })

// Scheduler endpoints
export const getSchedulerStatus = () => api.get('/scheduler/status')
export const startScheduler = () => api.post('/scheduler/start')
export const stopScheduler = () => api.post('/scheduler/stop')
export const getJobs = () => api.get('/scheduler/jobs')
export const pauseJob = (id) => api.post(`/scheduler/jobs/${id}/pause`)
export const resumeJob = (id) => api.post(`/scheduler/jobs/${id}/resume`)

export default api

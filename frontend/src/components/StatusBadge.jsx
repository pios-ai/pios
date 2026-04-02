import React from 'react'

export default function StatusBadge({ status, className = '' }) {
  const statusColors = {
    healthy: 'bg-green-100 text-green-800',
    running: 'bg-blue-100 text-blue-800',
    stopped: 'bg-gray-100 text-gray-800',
    idle: 'bg-gray-100 text-gray-800',
    error: 'bg-red-100 text-red-800',
    failed: 'bg-red-100 text-red-800',
    success: 'bg-green-100 text-green-800',
  }

  const color = statusColors[status] || 'bg-gray-100 text-gray-800'

  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium ${color} ${className}`}>
      {status}
    </span>
  )
}

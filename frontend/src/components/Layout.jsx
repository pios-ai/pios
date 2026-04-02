import React, { useState } from 'react'

export default function Layout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const navItems = [
    { name: 'Dashboard', icon: '📊', href: '/' },
    { name: 'Plugins', icon: '🔌', href: '/plugins' },
    { name: 'Documents', icon: '📄', href: '/documents' },
  ]

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'w-64' : 'w-20'
        } bg-gray-900 text-white transition-all duration-300 flex flex-col`}
      >
        {/* Logo */}
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          {sidebarOpen && <h1 className="text-xl font-bold">PiOS</h1>}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 hover:bg-gray-800 rounded transition-colors"
          >
            {sidebarOpen ? '←' : '→'}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <ul className="space-y-2">
            {navItems.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors"
                >
                  <span className="text-xl">{item.icon}</span>
                  {sidebarOpen && <span>{item.name}</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800">
          {sidebarOpen && (
            <p className="text-xs text-gray-400">
              Personal Intelligence OS v0.1.0
            </p>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        {/* Top Navigation */}
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">PiOS Dashboard</h2>
          <div className="flex items-center space-x-4">
            <button className="p-2 hover:bg-gray-100 rounded transition-colors">
              🔔
            </button>
            <button className="p-2 hover:bg-gray-100 rounded transition-colors">
              ⚙️
            </button>
          </div>
        </div>

        {/* Page Content */}
        <main className="p-6">
          {children}
        </main>
      </div>
    </div>
  )
}

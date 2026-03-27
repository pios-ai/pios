import React, { useState } from 'react'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Plugins from './pages/Plugins'
import Documents from './pages/Documents'
import './index.css'

export default function App() {
  const [currentPage, setCurrentPage] = useState('dashboard')

  // Route based on page state
  let PageComponent
  switch (currentPage) {
    case 'plugins':
      PageComponent = Plugins
      break
    case 'documents':
      PageComponent = Documents
      break
    default:
      PageComponent = Dashboard
  }

  // Also support hash-based routing
  const hashPage = window.location.hash.slice(1) || 'dashboard'

  let PageToRender
  switch (hashPage) {
    case 'plugins':
      PageToRender = Plugins
      break
    case 'documents':
      PageToRender = Documents
      break
    default:
      PageToRender = Dashboard
  }

  return (
    <Layout>
      <PageToRender />
    </Layout>
  )
}

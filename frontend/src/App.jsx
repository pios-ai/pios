import React from 'react'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Plugins from './pages/Plugins'
import Documents from './pages/Documents'
import './index.css'

export default function App() {
  const path = window.location.pathname.replace(/^\//, '') || 'dashboard'

  let PageToRender
  switch (path) {
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

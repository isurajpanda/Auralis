import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.jsx'
import Dashboard from './pages/Dashboard.jsx'
import 'bootstrap-icons/font/bootstrap-icons.css'
import './index.css'

// Shared live-call session between phone (/) and dashboard (/dashboard).
// nginx serves index.html for both paths (SPA fallback), so BrowserRouter
// resolves the route client-side.
function Site() {
  const [sessionId, setSessionId] = useState(null)
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App sessionId={sessionId} setSessionId={setSessionId} />} />
        <Route path="/dashboard" element={<Dashboard sessionId={sessionId} setSessionId={setSessionId} />} />
        <Route path="*" element={<App sessionId={sessionId} setSessionId={setSessionId} />} />
      </Routes>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Site />
  </React.StrictMode>,
)

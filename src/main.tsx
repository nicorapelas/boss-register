import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { applyPosThemeToDocument, readStoredPosTheme } from './theme/posTheme'
import './pos-theme-light.css'

applyPosThemeToDocument(readStoredPosTheme())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

window.ipcRenderer?.on('main-process-message', (_event, message) => {
  console.log(message)
})

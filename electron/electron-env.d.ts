/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    APP_ROOT: string
    VITE_PUBLIC: string
  }
}

interface Window {
  ipcRenderer: import('electron').IpcRenderer
  electronAuth: {
    setBundle: (json: string) => Promise<{ ok: boolean; error?: string }>
    getBundle: () => Promise<string | null>
    clear: () => Promise<{ ok: boolean }>
  }
  electronPos: {
    openDrawer: () => Promise<{ ok: boolean; mode?: 'simulated'; error?: string }>
  }
}

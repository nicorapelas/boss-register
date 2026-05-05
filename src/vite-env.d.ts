/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_APP_VERSION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  ipcRenderer?: import('electron').IpcRenderer
  electronAuth?: {
    setBundle: (json: string) => Promise<{ ok: boolean; error?: string }>
    getBundle: () => Promise<string | null>
    clear: () => Promise<{ ok: boolean }>
  }
  electronPos?: {
    openDrawer: (transport?: unknown) => Promise<{ ok: boolean; error?: string }>
    kickDrawer: (transport: unknown) => Promise<{ ok: boolean; error?: string }>
    printReceipt: (
      transport: unknown,
      receipt: unknown,
      opts?: { columns?: number; cut?: boolean },
    ) => Promise<{ ok: boolean; error?: string }>
  }
}

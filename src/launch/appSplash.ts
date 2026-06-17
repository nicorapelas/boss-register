const SPLASH_HIDE_MS = 280

export function hideAppSplash(): void {
  const splash = document.getElementById('app-splash')
  if (!splash || splash.classList.contains('app-splash--hidden')) return
  splash.classList.add('app-splash--hidden')
  window.setTimeout(() => splash.remove(), SPLASH_HIDE_MS)
}

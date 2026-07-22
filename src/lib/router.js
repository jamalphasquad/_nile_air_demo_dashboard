// Minimal hash router. Routes are (path -> render(mountEl)); the shell owns layout.
export function createRouter(routes, notFound) {
  let current = null
  function resolve() {
    const hash = location.hash.replace(/^#/, '') || '/'
    const view = routes[hash] || notFound
    current?.cleanup?.()
    current = view()
    return current
  }
  window.addEventListener('hashchange', () => window.dispatchEvent(new Event('route')))
  return { resolve, path: () => location.hash.replace(/^#/, '') || '/' }
}

export function navigate(path) { location.hash = `#${path}` }

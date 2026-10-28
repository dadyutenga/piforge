const loadingScripts = new Map()

export function loadVendorScript(url) {
  if (loadingScripts.has(url)) return loadingScripts.get(url)
  const existing = document.querySelector(`script[data-src="${url}"]`)
  if (existing?.dataset.loaded === 'true') return Promise.resolve()
  const script = existing || document.createElement('script')
  script.src = url
  script.dataset.src = url
  const promise = new Promise((resolve, reject) => {
    script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve() }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      loadingScripts.delete(url)
      reject(new Error(`Could not load ${url}`))
    }, { once: true })
  })
  loadingScripts.set(url, promise)
  if (!existing) document.head.append(script)
  return promise
}

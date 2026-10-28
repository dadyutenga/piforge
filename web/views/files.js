import { api, mutate } from '../api.js'
import { icon, esc, bytes, time, pageIntro, skeleton, errorBox, state } from '../util.js'
import { loadVendorScript } from '../vendor-loader.js'

function parent(path) { const parts = path.split('/').filter(Boolean); parts.pop(); return parts.join('/') }
function join(folder, name) { return folder ? `${folder}/${name}` : name }
function breadcrumbs(path) {
  const parts = path.split('/').filter(Boolean)
  return `<button data-folder="" aria-label="Workspace root">Workspace</button>${parts.map((part, i) => `${icon('chevron-right', 14)}<button data-folder="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('')}`
}
function askText(title, label, initial = '') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'confirm-dialog'
    dialog.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><label for="dialog-value">${esc(label)}</label><input id="dialog-value" required maxlength="120" value="${esc(initial)}"><div class="dialog-actions"><button class="button secondary" value="cancel">Cancel</button><button class="button primary" value="save">Save</button></div></form>`
    document.body.append(dialog)
    dialog.onclose = () => { const value = dialog.returnValue === 'save' ? dialog.querySelector('input').value.trim() : null; dialog.remove(); resolve(value) }
    dialog.showModal(); dialog.querySelector('input').focus(); dialog.querySelector('input').select()
  })
}
function confirmDelete(count) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.className = 'confirm-dialog'
    dialog.innerHTML = `<form method="dialog"><h2>Delete ${count === 1 ? 'item' : `${count} items`}?</h2><p>This permanently removes the selected files or folders from the PiForge workspace.</p><div class="dialog-actions"><button class="button secondary" value="cancel">Cancel</button><button class="button danger" value="delete">Delete</button></div></form>`
    document.body.append(dialog)
    dialog.onclose = () => { const yes = dialog.returnValue === 'delete'; dialog.remove(); resolve(yes) }
    dialog.showModal()
  })
}
function safeName(name) { return name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..' }

export async function mountFiles(page, ctx) {
  let folder = '', entries = [], selected = new Set(), view = localStorage.getItem('piforge.filesView') || 'list', sort = 'name', query = '', preview = null, cancelled = false
  page.innerHTML = `${pageIntro('File manager', 'Browse the PiForge workspace.')}<section class="panel">${skeleton(5)}</section>`
  const refresh = async () => {
    try { const data = await ctx.api(`/api/files?path=${encodeURIComponent(folder)}`); if (cancelled) return; entries = data.entries || []; selected.clear(); render() }
    catch (error) { if (!cancelled) { page.innerHTML = errorBox(error.message); page.querySelector('[data-action=retry]')?.addEventListener('click', refresh) } }
  }
  function visibleEntries() {
    const list = entries.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
    list.sort((a, b) => sort === 'size' ? b.size - a.size : sort === 'date' ? new Date(b.modified) - new Date(a.modified) : a.type !== b.type ? a.type === 'directory' ? -1 : 1 : a.name.localeCompare(b.name))
    return list
  }
  function render() {
    const items = visibleEntries()
    page.innerHTML = `<div class="workspace-page"><div class="page-intro"><div><h1>File manager</h1><p>Browse and manage your PiForge workspace.</p></div><div class="page-action"><button class="button secondary" data-action="new-folder">${icon('folder-plus', 16)} New folder</button><button class="button primary" data-action="upload">${icon('upload', 16)} Upload files</button><input id="file-upload" type="file" multiple hidden></div></div><div class="file-layout"><aside class="file-sidebar"><p class="small-label">Locations</p><button class="file-location" data-folder="">${icon('folder', 18)} Workspace</button><button class="file-location" data-folder="${esc(folder)}">${icon('folder', 18)} Current folder</button><div class="sidebar-tip">Files stay inside your PiForge workspace.</div></aside><section class="panel file-panel"><div class="file-toolbar"><div class="breadcrumbs">${breadcrumbs(folder)}</div><div class="file-toolbar-actions"><button class="icon-button" data-action="refresh" title="Refresh">${icon('refresh-cw', 17)}</button><button class="icon-button ${view === 'list' ? 'selected' : ''}" data-view="list" title="List view">${icon('list', 17)}</button><button class="icon-button ${view === 'grid' ? 'selected' : ''}" data-view="grid" title="Grid view">${icon('layout-dashboard', 17)}</button></div></div><div class="file-filter"><label>${icon('search', 16)}<input id="file-search" type="search" value="${esc(query)}" placeholder="Search this folder"></label><select id="file-sort" aria-label="Sort files"><option value="name" ${sort === 'name' ? 'selected' : ''}>Name</option><option value="size" ${sort === 'size' ? 'selected' : ''}>Size</option><option value="date" ${sort === 'date' ? 'selected' : ''}>Modified</option></select><span class="file-count">${items.length} items</span></div>${selected.size ? `<div class="selection-bar"><strong>${selected.size} selected</strong><button class="button secondary" data-action="copy">${icon('copy', 15)} Copy</button><button class="button danger" data-action="delete">${icon('trash-2', 15)} Delete</button></div>` : ''}${items.length ? `<div class="file-${view}">${items.map(item => `<div class="file-item ${selected.has(item.path) ? 'selected' : ''}" data-entry="${esc(item.path)}"><label class="file-select"><input type="checkbox" data-select="${esc(item.path)}" ${selected.has(item.path) ? 'checked' : ''} aria-label="Select ${esc(item.name)}"></label><button class="file-name" data-open="${esc(item.path)}"><span class="file-icon ${item.type}">${icon(item.type === 'directory' ? 'folder' : item.type === 'symlink' ? 'external-link' : 'file', 20)}</span><span><strong>${esc(item.name)}</strong><small>${item.type === 'directory' ? 'Folder' : bytes(item.size)}</small></span></button><span class="file-meta">${item.type === 'directory' ? 'Folder' : bytes(item.size)}</span><time class="file-date">${time(item.modified)}</time><button class="icon-button file-more" data-more="${esc(item.path)}" aria-label="Actions for ${esc(item.name)}">${icon('ellipsis', 18)}</button></div>`).join('')}</div>` : state(query ? 'No matches' : 'This folder is empty', query ? 'Try another search term.' : 'Upload a file or create a folder to get started.')}<div class="file-drop-hint">Drop files here to upload</div></section>${preview ? `<aside class="file-preview"><div class="preview-head"><strong>Preview</strong><button class="icon-button" data-action="close-preview" aria-label="Close preview">${icon('x', 17)}</button></div><div class="preview-body"><div class="preview-glyph">${icon('file-text', 26)}</div><h2>${esc(preview.name)}</h2><p>${bytes(preview.size)} · ${time(preview.modified)}</p>${preview.content !== null ? `<pre>${esc(preview.content.slice(0, 4000))}</pre><a class="button secondary" href="/editor" data-route="/editor" data-open-editor="${esc(preview.path)}">${icon('code-2', 16)} Open in editor</a>` : `<p>Preview is unavailable for this file type.</p>`}<a class="button secondary" href="/api/files/download?path=${encodeURIComponent(preview.path)}">${icon('download', 16)} Download</a><button class="button secondary" data-action="rename-preview">${icon('pencil', 16)} Rename</button></div></aside>` : ''}</div></div>`
  }
  async function uploadFiles(files) {
    if (!files.length) return
    let done = 0
    for (const file of files) {
      const form = new FormData(); form.append('path', folder); form.append('file', file)
      try { await api('/api/files/upload', { method: 'POST', body: form }); done++ }
      catch (error) { ctx.toast(`${file.name}: ${error.message}`, 'error') }
    }
    if (done) ctx.toast(`${done} file${done === 1 ? '' : 's'} uploaded`)
    await refresh()
  }
  page.addEventListener('click', async event => {
    const target = event.target.closest('[data-action],[data-folder],[data-open],[data-view],[data-more],[data-open-editor]')
    if (!target) return
    if (target.dataset.folder !== undefined) { folder = target.dataset.folder; query = ''; preview = null; await refresh(); return }
    if (target.dataset.view) { view = target.dataset.view; localStorage.setItem('piforge.filesView', view); render(); return }
    if (target.dataset.openEditor) { localStorage.setItem('piforge.editorPath', target.dataset.openEditor); return }
    if (target.dataset.open) {
      const item = entries.find(entry => entry.path === target.dataset.open)
      if (!item) return
      if (item.type === 'directory') { folder = item.path; query = ''; preview = null; await refresh() }
      else {
        let content = null
        try { const result = await ctx.api(`/api/files/content?path=${encodeURIComponent(item.path)}`); content = result.content } catch { /* binary or too large */ }
        preview = { ...item, content }; render()
      }
      return
    }
    if (target.dataset.more) {
      const item = entries.find(entry => entry.path === target.dataset.more)
      if (!item) return
      const choice = await askText(`Action for ${item.name}`, 'Type rename, copy, download or delete')
      if (choice === 'rename') { const name = await askText('Rename item', 'New name', item.name); if (safeName(name)) { try { await mutate('/api/files/rename', 'POST', { from: item.path, to: join(folder, name) }); ctx.toast('Renamed'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } } }
      else if (choice === 'copy' && item.type === 'file') { const name = await askText('Copy file', 'New file name', `copy-${item.name}`); if (safeName(name)) { try { await mutate('/api/files/copy', 'POST', { from: item.path, to: join(folder, name) }); ctx.toast('Copied'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } } }
      else if (choice === 'delete' && await confirmDelete(1)) { try { await api(`/api/files?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' }); ctx.toast('Deleted'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } }
      else if (choice === 'download' && item.type === 'file') location.href = `/api/files/download?path=${encodeURIComponent(item.path)}`
      return
    }
    const action = target.dataset.action
    if (action === 'refresh') await refresh()
    if (action === 'upload') page.querySelector('#file-upload').click()
    if (action === 'new-folder') { const name = await askText('Create folder', 'Folder name'); if (safeName(name)) { try { await mutate('/api/files/folder', 'POST', { path: join(folder, name) }); ctx.toast('Folder created'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } } }
    if (action === 'close-preview') { preview = null; render() }
    if (action === 'rename-preview' && preview) { const name = await askText('Rename item', 'New name', preview.name); if (safeName(name)) { try { await mutate('/api/files/rename', 'POST', { from: preview.path, to: join(folder, name) }); preview = null; ctx.toast('Renamed'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } } }
    if (action === 'delete' && selected.size && await confirmDelete(selected.size)) { let done = 0; for (const path of selected) { try { await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); done++ } catch (error) { ctx.toast(error.message, 'error') } } if (done) ctx.toast(`${done} item${done === 1 ? '' : 's'} deleted`); await refresh() }
    if (action === 'copy' && selected.size === 1) { const item = entries.find(e => e.path === [...selected][0]); if (item?.type === 'file') { const name = await askText('Copy file', 'New file name', `copy-${item.name}`); if (safeName(name)) { try { await mutate('/api/files/copy', 'POST', { from: item.path, to: join(folder, name) }); ctx.toast('Copied'); await refresh() } catch (error) { ctx.toast(error.message, 'error') } } } else ctx.toast('Copy supports one file at a time', 'error') }
  })
  page.addEventListener('change', event => {
    if (event.target.matches('[data-select]')) { event.target.checked ? selected.add(event.target.dataset.select) : selected.delete(event.target.dataset.select); render() }
    if (event.target.id === 'file-sort') { sort = event.target.value; render() }
    if (event.target.id === 'file-upload') uploadFiles([...event.target.files])
  })
  page.addEventListener('input', event => { if (event.target.id === 'file-search') { query = event.target.value; const start = event.target.selectionStart; render(); const input = page.querySelector('#file-search'); input.focus(); input.setSelectionRange(start, start) } })
  page.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); page.classList.add('drag-active') } })
  page.addEventListener('dragleave', event => { if (!page.contains(event.relatedTarget)) page.classList.remove('drag-active') })
  page.addEventListener('drop', event => { event.preventDefault(); page.classList.remove('drag-active'); uploadFiles([...event.dataTransfer.files]) })
  await refresh()
  return () => { cancelled = true; page.classList.remove('drag-active') }
}

function loadCSS(url) { if (document.querySelector(`link[href="${url}"]`)) return; const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url; document.head.append(link) }
function mode(path) { const ext = path.split('.').pop().toLowerCase(); return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'javascript', ts: 'javascript', py: 'python', go: 'go', sh: 'shell', bash: 'shell', md: 'markdown', css: 'css', html: 'xml', xml: 'xml' })[ext] || 'text/plain' }

export async function mountEditor(page, ctx) {
  page.innerHTML = `${pageIntro('Code editor', 'Edit files in your PiForge workspace.')}<section class="panel">${skeleton()}</section>`
  loadCSS('/vendor/codemirror/codemirror.css')
  await loadVendorScript('/vendor/codemirror/codemirror.js')
  for (const name of ['javascript', 'python', 'go', 'shell', 'markdown', 'css', 'xml']) await loadVendorScript(`/vendor/codemirror/mode/${name}.js`)
  await loadVendorScript('/vendor/codemirror/addon/matchbrackets.js')
  if (!page.isConnected) return
  const tabs = new Map(); let active = '', folder = '', entries = [], editor = null, cancelled = false
  async function list() { const result = await ctx.api(`/api/files?path=${encodeURIComponent(folder)}`); entries = result.entries; draw() }
  function draw() {
    if (editor) { editor.toTextArea(); editor = null }
    page.innerHTML = `<div class="editor-page"><div class="page-intro"><div><h1>Code editor</h1><p>Edit files in your PiForge workspace.</p></div><div class="page-action"><button class="button secondary" data-action="new">${icon('file-plus', 16)} New file</button><button class="button primary" data-action="save" ${!active ? 'disabled' : ''}>${icon('check', 16)} Save</button></div></div><div class="editor-layout"><aside class="editor-tree"><div class="editor-tree-head"><strong>Explorer</strong><button class="icon-button" data-action="refresh" aria-label="Refresh files">${icon('refresh-cw', 16)}</button></div><div class="breadcrumbs">${breadcrumbs(folder)}</div><div class="editor-files">${entries.map(item => `<button data-file="${esc(item.path)}" class="${active === item.path ? 'active' : ''}">${icon(item.type === 'directory' ? 'folder' : 'file', 16)}${esc(item.name)}</button>`).join('')}</div></aside><section class="editor-main"><div class="editor-tabs">${tabs.size ? [...tabs.keys()].map(path => `<button data-tab="${esc(path)}" class="${active === path ? 'active' : ''}">${icon('file', 14)}${esc(path.split('/').pop())}${tabs.get(path).dirty ? '<span class="dirty-dot"></span>' : ''}<span class="tab-close" data-close="${esc(path)}">×</span></button>`).join('') : '<span>Open a file from the explorer</span>'}</div><div class="editor-surface" id="editor-surface">${active ? '<textarea id="editor-text"></textarea>' : `<div class="editor-empty">${icon('code-2', 42)}<h2>Your workspace is ready</h2><p>Choose a file from the explorer to start editing.</p></div>`}</div><div class="editor-status"><span>${active ? esc(active) : 'No file open'}</span><span>${active ? esc(mode(active)) : 'PiForge editor'}</span></div></section></div></div>`
    if (active) {
      const tab = tabs.get(active)
      page.querySelector('#editor-text').value = tab.content
      editor = window.CodeMirror.fromTextArea(page.querySelector('#editor-text'), { lineNumbers: true, lineWrapping: false, mode: mode(active), matchBrackets: true, indentUnit: 2, tabSize: 2, extraKeys: { 'Ctrl-S': save, 'Cmd-S': save } })
      editor.on('change', () => { const current = tabs.get(active); if (current) { current.content = editor.getValue(); current.dirty = current.content !== current.saved; page.querySelector(`[data-tab="${CSS.escape(active)}"] .dirty-dot`)?.remove(); if (current.dirty && !page.querySelector(`[data-tab="${CSS.escape(active)}"] .dirty-dot`)) page.querySelector(`[data-tab="${CSS.escape(active)}"] .tab-close`)?.insertAdjacentHTML('beforebegin', '<span class="dirty-dot"></span>') } })
      editor.focus()
    }
  }
  async function open(path) {
    if (tabs.has(path)) { active = path; draw(); return }
    try { const result = await ctx.api(`/api/files/content?path=${encodeURIComponent(path)}`); tabs.set(path, { content: result.content, saved: result.content, dirty: false }); active = path; draw() }
    catch (error) { ctx.toast(error.message, 'error') }
  }
  async function save() {
    if (!active) return
    const tab = tabs.get(active); tab.content = editor.getValue()
    try { await mutate('/api/files/content', 'PUT', { path: active, content: tab.content }); tab.saved = tab.content; tab.dirty = false; ctx.toast('File saved'); draw() }
    catch (error) { ctx.toast(error.message, 'error') }
  }
  page.addEventListener('click', async event => {
    const target = event.target.closest('[data-file],[data-folder],[data-tab],[data-close],[data-action]'); if (!target) return
    if (target.dataset.folder !== undefined) { folder = target.dataset.folder; await list(); return }
    if (target.dataset.file) { const item = entries.find(e => e.path === target.dataset.file); if (item?.type === 'directory') { folder = item.path; await list() } else if (item?.type === 'file') await open(item.path); return }
    if (target.dataset.close) { const path = target.dataset.close; if (tabs.get(path)?.dirty && !window.confirm(`${path} has unsaved changes. Close it?`)) return; tabs.delete(path); if (active === path) active = [...tabs.keys()].at(-1) || ''; draw(); return }
    if (target.dataset.tab) { active = target.dataset.tab; draw(); return }
    if (target.dataset.action === 'save') await save()
    if (target.dataset.action === 'refresh') await list()
    if (target.dataset.action === 'new') { const name = await askText('Create file', 'File name'); if (safeName(name)) { const path = join(folder, name); try { await mutate('/api/files/content', 'PUT', { path, content: '' }); await list(); await open(path); ctx.toast('File created') } catch (error) { ctx.toast(error.message, 'error') } } }
  })
  try { await list(); const wanted = localStorage.getItem('piforge.editorPath'); if (wanted) { localStorage.removeItem('piforge.editorPath'); await open(wanted) } }
  catch (error) { page.innerHTML = errorBox(error.message) }
  const beforeUnload = event => { if ([...tabs.values()].some(tab => tab.dirty)) { event.preventDefault(); event.returnValue = '' } }
  window.addEventListener('beforeunload', beforeUnload)
  const cleanup = () => { cancelled = true; editor?.toTextArea(); window.removeEventListener('beforeunload', beforeUnload) }
  cleanup.canLeave = () => ![...tabs.values()].some(tab => tab.dirty) || window.confirm('Discard unsaved changes in the code editor?')
  return cleanup
}

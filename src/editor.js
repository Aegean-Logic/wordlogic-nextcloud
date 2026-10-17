// The editor page: WordLogic runs in an iframe on this origin (`?host=parent&ack=1`). This page
// reads the file over WebDAV with the user's session, hands it to WordLogic, and writes back
// what WordLogic saves. Protocol: wordcraft/packaging/web/README.md.

import { getCurrentUser, getRequestToken } from '@nextcloud/auth'
import { generateRemoteUrl } from '@nextcloud/router'

const root = document.getElementById('wordcraft-app')
const status = document.getElementById('wordcraft-status')
const path = root?.dataset.path ?? ''
const user = getCurrentUser()

/** The folder of `path` and its file name. */
function split(p) {
	const i = p.lastIndexOf('/')
	return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]
}

const [folder, fileName] = split(path)

/**
 * Formats WordLogic's engine writes, so a document in one of them is saved back as it is. Others
 * (.doc, .dot) are imports: WordLogic saves them as `<name>.docx` next to the original.
 */
const SAVES_IN_PLACE = ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'txt', 'md', 'markdown']

/** The extension of a file name, lower-case ('' if none). */
function extensionOf(name) {
	const i = name.lastIndexOf('.')
	return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** WebDAV URL of a path in the user's files. */
function davUrl(p) {
	const encoded = p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
	return `${generateRemoteUrl(`dav/files/${encodeURIComponent(user.uid)}`)}/${encoded}`
}

function show(text, error = false) {
	status.textContent = text
	status.classList.toggle('error', error)
	status.hidden = false
}

/** Known ETags by path: the file opened, and files this page created. */
const etags = new Map()
let dirty = false
/** The document's current name: an imported .doc becomes .docx once saved. */
let shownName = fileName

function showTitle() {
	document.title = `${dirty ? '• ' : ''}${shownName} - WordLogic`
}

function headers(extra = {}) {
	return { requesttoken: getRequestToken() ?? '', ...extra }
}

async function load(frame) {
	const response = await fetch(davUrl(path), { headers: headers(), credentials: 'same-origin' })
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`)
	}
	const etag = response.headers.get('ETag')
	if (etag) {
		etags.set(path, etag)
	}
	const bytes = await response.arrayBuffer()
	frame.contentWindow.postMessage({ type: 'wordcraft:open', name: fileName, bytes }, location.origin, [bytes])
	showTitle()
}

/** Store a file WordLogic saved next to the opened one. Resolves to the reply for WordLogic. */
async function store(message) {
	const name = String(message.name ?? '').split(/[\\/]/).pop()
	if (!name) {
		return { type: 'wordcraft:saveFailed', id: message.id, error: 'The file has no name.' }
	}
	const target = folder ? `${folder}/${name}` : name
	const known = etags.get(target)
	// Overwrite only the version we know; never a file this page didn't open or create.
	const condition = known ? { 'If-Match': known } : { 'If-None-Match': '*' }
	const response = await fetch(davUrl(target), {
		method: 'PUT',
		headers: headers(condition),
		credentials: 'same-origin',
		body: message.bytes,
	})
	if (response.status === 412) {
		const error = known
			? 'Someone else changed this file since you opened it. Save it under another name to keep your changes.'
			: `A file named ${name} already exists in this folder.`
		return { type: 'wordcraft:saveFailed', id: message.id, error }
	}
	if (!response.ok) {
		return { type: 'wordcraft:saveFailed', id: message.id, error: `Nextcloud answered ${response.status} ${response.statusText}.` }
	}
	const etag = response.headers.get('OC-ETag') ?? response.headers.get('ETag')
	if (etag) {
		etags.set(target, etag.startsWith('"') ? etag : `"${etag}"`)
	} else {
		etags.delete(target)
	}
	if (SAVES_IN_PLACE.includes(extensionOf(name))) {
		shownName = name
		showTitle()
	}
	return { type: 'wordcraft:saved', id: message.id, name }
}

function start() {
	if (!root || !status) {
		return
	}
	if (!user) {
		show('Sign in to Nextcloud to open files in WordLogic.', true)
		return
	}
	if (!path) {
		show('No file to open. Open a document from Files with "Open in WordLogic".', true)
		return
	}
	if (root.dataset.editorMissing === '1') {
		show("The WordLogic editor isn't installed in this app yet (see editor/README.md in the app).", true)
		return
	}
	const editorUrl = new URL(root.dataset.editorUrl, location.href)
	// Added to the page's own query (`v`, the app version), which keeps browser caches current.
	for (const [key, value] of Object.entries({ host: 'parent', ack: '1', author: user.displayName ?? user.uid })) {
		editorUrl.searchParams.set(key, value)
	}

	const frame = document.createElement('iframe')
	frame.title = 'WordLogic document'
	frame.allow = 'fullscreen; clipboard-read; clipboard-write'
	let opened = false

	addEventListener('message', async (event) => {
		if (event.origin !== location.origin || event.source !== frame.contentWindow) {
			return
		}
		const message = event.data ?? {}
		switch (message.type) {
		case 'wordcraft:ready':
			if (opened) {
				return
			}
			opened = true
			if (!message.ack) {
				console.warn('WordLogic: this build does not confirm saves; a failed save will not be reported')
			}
			try {
				await load(frame)
				status.hidden = true
			} catch (e) {
				show(`Couldn't open ${fileName}: ${e.message}`, true)
			}
			break
		case 'wordcraft:save': {
			let reply
			try {
				reply = await store(message)
			} catch (e) {
				reply = { type: 'wordcraft:saveFailed', id: message.id, error: `Couldn't reach Nextcloud: ${e.message}` }
			}
			frame.contentWindow.postMessage(reply, location.origin)
			break
		}
		case 'wordcraft:dirty':
			dirty = Boolean(message.dirty)
			showTitle()
			break
		case 'wordcraft:failed':
			show(`WordLogic couldn't start: ${message.error}`, true)
			break
		}
	})

	addEventListener('beforeunload', (event) => {
		if (dirty) {
			event.preventDefault()
		}
	})

	frame.src = editorUrl.toString()
	root.appendChild(frame)
}

start()

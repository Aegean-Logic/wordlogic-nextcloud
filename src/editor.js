// The editor page: WordLogic runs in an iframe on this origin (`?host=parent&ack=1`). This page
// reads the file over WebDAV with the user's session, hands it to WordLogic, and writes back
// what WordLogic saves. Protocol: README.md, "Protocol".
//
// The same page serves shared links (`/s/{token}`, `data-share-token`): the file is then the
// link's own WebDAV address (a link to a folder: the document's address in it,
// `data-share-path`), and the person is a guest under the name they gave Nextcloud.

import { getCurrentUser, getGuestNickname, getRequestToken } from '@nextcloud/auth'
import { generateRemoteUrl, generateUrl, getRootUrl } from '@nextcloud/router'

import { Collab, colorFor } from './collab.js'
import { guestSharing, sharing } from './share.js'
import { mountTalk } from './talk.js'

const root = document.getElementById('wordcraft-app')
const status = document.getElementById('wordcraft-status')
const path = root?.dataset.path ?? ''
const fileId = Number(root?.dataset.fileId ?? 0)
/** A shared link's token: the page is the link's. */
const token = root?.dataset.shareToken ?? ''
const viaLink = token !== ''
/** Through a link to a folder: the document's path in it (`/Reports/Report.docx`). */
const sharePath = root?.dataset.sharePath ?? ''
/** Whether the link lets people edit (signed-in users: Nextcloud decides on each save). */
const linkCanEdit = root?.dataset.canEdit === '1'
const user = getCurrentUser()
/** How the others see this person. */
const personName = user?.displayName || user?.uid || getGuestNickname() || 'Guest'

/** The folder of `path` and its file name. */
function split(p) {
	const i = p.lastIndexOf('/')
	return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]
}

const [folder, fileName] = viaLink ? ['', root?.dataset.fileName ?? ''] : split(path)

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

/**
 * Whether the opened file is co-edited: everyone's edits are saved back into it, so only a format
 * WordLogic writes (an imported .doc opens for one person and is saved as .docx).
 */
const coEdits = SAVES_IN_PLACE.includes(extensionOf(fileName))

/** Whether WordLogic is saving the opened file itself (not a copy in another format or a PDF). */
function isOpenedFile(name) {
	return String(name ?? '').split(/[\\/]/).pop().toLowerCase() === fileName.toLowerCase()
}

/** WebDAV URL of a path in the user's files; through a link, the shared file's. */
function davUrl(p) {
	if (viaLink) {
		const inFolder = sharePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
		return `${getRootUrl()}/public.php/dav/files/${encodeURIComponent(token)}${inFolder ? `/${inFolder}` : ''}`
	}
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

/** The co-editing session, once joined. */
let collab = null
/** Carries out the Share dialog's requests (made on first use). */
let shareHandler = null
/** Who else is in it. */
let others = 0

function showTitle() {
	const unsaved = collab ? collab.unsaved : dirty
	const company = others > 0 ? ` (${others + 1} editing)` : ''
	document.title = `${unsaved ? '• ' : ''}${shownName}${company} - WordLogic`
}

/** A message over the top of the editor, not covering it (co-editing). */
function notify(text, error = false) {
	let bar = document.getElementById('wordcraft-notice')
	if (!bar) {
		bar = document.createElement('div')
		bar.id = 'wordcraft-notice'
		root.prepend(bar)
	}
	bar.textContent = text
	bar.classList.toggle('error', error)
	clearTimeout(bar.timer)
	bar.timer = setTimeout(() => bar.remove(), error ? 15000 : 5000)
}

function headers(extra = {}) {
	// X-Requested-With: a link's WebDAV answers a missing password with 401, not a login prompt.
	return { requesttoken: getRequestToken() ?? '', 'X-Requested-With': 'XMLHttpRequest', ...extra }
}

async function load(frame) {
	const response = await fetch(davUrl(path), { headers: headers(), credentials: 'same-origin', cache: 'no-store' })
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
	if (viaLink && !linkCanEdit) {
		return { type: 'wordcraft:saveFailed', id: message.id, error: 'This link lets you view the document, not change it. Download a copy to keep your changes.' }
	}
	if (viaLink && name !== fileName) {
		return { type: 'wordcraft:saveFailed', id: message.id, error: `This link can only save ${fileName}. Download a copy to keep it under another name.` }
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
	if (!user && !viaLink) {
		show('Sign in to Nextcloud to open files in WordLogic.', true)
		return
	}
	if (!path && !viaLink) {
		show('No file to open. Open a document from Files with "Open in WordLogic".', true)
		return
	}
	if (root.dataset.editorMissing === '1') {
		show("The WordLogic editor isn't installed in this app yet (see editor/README.md in the app).", true)
		return
	}
	const editorUrl = new URL(root.dataset.editorUrl, location.href)
	// Added to the page's own query (`v`, the app version), which keeps browser caches current.
	const params = { host: 'parent', ack: '1', author: personName }
	if (!viaLink) {
		// The document can carry on in WordLogic on this computer (Open in Desktop App).
		params.desktop = '1'
	}
	// A mention's link names its comment: WordLogic opens it once the document is in.
	const comment = new URLSearchParams(location.search).get('comment')
	if (comment) {
		params.comment = comment.slice(0, 300)
	}
	for (const [key, value] of Object.entries(params)) {
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
				if (message.collab && fileId > 0 && coEdits) {
					await share(frame, message.collab)
				} else {
					await load(frame)
				}
				status.hidden = true
			} catch (e) {
				show(`Couldn't open ${fileName}: ${e.message}`, true)
			}
			break
		case 'wordcraft:save': {
			let reply
			try {
				// Shared: Save writes the document as everyone has it.
				if (collab && isOpenedFile(message.name)) {
					await collab.checkpoint()
					reply = { type: 'wordcraft:saved', id: message.id }
					showTitle()
				} else {
					reply = await store(message)
				}
			} catch (e) {
				reply = { type: 'wordcraft:saveFailed', id: message.id, error: e.message }
			}
			frame.contentWindow.postMessage(reply, location.origin)
			break
		}
		case 'wordcraft:collab:op':
			collab?.queue(message.json)
			showTitle()
			break
		case 'wordcraft:collab:checkpointData':
			collab?.received(message)
			break
		case 'wordcraft:cloud': {
			// The Share dialog asks; Nextcloud answers. Guests on a link can only pass the link on.
			shareHandler ??= viaLink
				? guestSharing({ name: shownName, link: `${location.origin}${location.pathname}` })
				: sharing({ path, name: shownName, davUrl: davUrl(path), fileId })
			const reply = await shareHandler(message)
			frame.contentWindow.postMessage(reply, location.origin)
			break
		}
		case 'wordcraft:openDesktop':
			openInDesktop(path)
			notify('Opening in WordLogic on this computer… If nothing happens, install WordLogic for your computer first.')
			break
		case 'wordcraft:collab:selection':
			collab?.setSelection(message.json)
			break
		case 'wordcraft:collab:error':
			console.warn('WordLogic co-editing:', message.error)
			collab?.rejoin()
			break
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
		if (collab ? collab.unsaved : dirty) {
			event.preventDefault()
		}
	})

	frame.src = editorUrl.toString()
	// The editor, with the chat beside it when it's open.
	const stage = document.createElement('div')
	stage.className = 'aegean-stage'
	stage.append(frame)
	root.appendChild(stage)

	mountTalk({
		app: 'wordcraft',
		bar: peopleBar(),
		stage,
		fileId,
		shareToken: token,
		sharePath,
		guestName: user ? '' : (getGuestNickname() ?? ''),
		// A chat mention's link (MentionService::link): the chat opens with the file.
		openChat: new URLSearchParams(location.search).get('chat') === '1',
		fileName: () => shownName,
		headers,
	}).catch((e) => console.warn('WordLogic: no chat', e))
}

/**
 * Opens a file of the user's in WordLogic on this computer: a `wordlogic://open` link with this
 * Nextcloud's address and the file's path. The desktop app signs in to this server if it isn't
 * yet, then opens the file in the same co-editing session as this page.
 */
export function openInDesktop(filePath) {
	const server = `${location.origin}${getRootUrl()}`
	location.href = `wordlogic://open?server=${encodeURIComponent(server)}&path=${encodeURIComponent(filePath)}`
}

/**
 * The bar above the editor: who's editing, and the Chat and Call buttons (talk.js). Hidden until
 * either has something to show.
 */
function peopleBar() {
	let strip = document.getElementById('wordcraft-people')
	if (!strip) {
		strip = document.createElement('div')
		strip.id = 'wordcraft-people'
		strip.hidden = true
		strip.append(Object.assign(document.createElement('span'), { className: 'people' }))
		strip.lastChild.setAttribute('aria-label', "Who's editing")
		root.prepend(strip)
	}
	return strip
}

/** Who's editing, above the editor: each person in the colour they're drawn in in the document. */
function showPeople(members) {
	const bar = peopleBar()
	bar.hidden = false
	const strip = bar.querySelector('.people')
	const me = collab?.client
	const sorted = [...members].sort((a, b) => (a.client === me ? -1 : b.client === me ? 1 : a.client - b.client))
	const key = JSON.stringify(sorted.map((m) => [m.client, m.displayName]))
	if (strip.dataset.key === key) {
		return
	}
	strip.dataset.key = key
	strip.replaceChildren(
		Object.assign(document.createElement('span'), { className: 'label', textContent: sorted.length > 1 ? 'Editing now:' : 'Only you are editing' }),
	)
	if (sorted.length < 2) {
		return
	}
	for (const m of sorted) {
		const name = m.displayName || m.userId
		const chip = document.createElement('span')
		chip.className = 'person'
		chip.style.setProperty('--person', colorFor(m.client))
		chip.title = m.client === me ? `${name} (you)` : name
		const initials = Object.assign(document.createElement('span'), { className: 'initials', textContent: initialsOf(name) })
		chip.append(initials, document.createTextNode(m.client === me ? `${name} (you)` : name))
		strip.append(chip)
	}
}

function initialsOf(name) {
	const parts = String(name).trim().split(/\s+/).filter(Boolean)
	return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * Opens the file in a co-editing session: everyone with it open edits the same document.
 * `protocol`: what the editor's edits mean (`wordcraft:ready`'s `collab`; `true` from the first
 * builds that co-edited). The server keeps a session to the newest, so every copy reads the edits
 * alike, the desktop app's included.
 */
async function share(frame, protocol) {
	collab = new Collab({
		frame,
		fileId,
		fileUrl: davUrl(path),
		headers,
		notify,
		endpoint: viaLink ? generateUrl(`/apps/wordcraft/s/${encodeURIComponent(token)}/collab`) : generateUrl('/apps/wordcraft/collab'),
		joinParams: viaLink ? { displayName: personName, path: sharePath } : {},
		build: String(typeof protocol === 'number' ? protocol : 1),
		person: personName,
		onMembers(members) {
			others = Math.max(0, members.length - 1)
			showPeople(members)
			showTitle()
		},
	})
	const { bytes, seq, state, entries } = await collab.join()
	// The file names the document and its format; a state snapshot, when the session keeps one,
	// is the shared document itself (collab:start).
	frame.contentWindow.postMessage({ type: 'wordcraft:open', name: fileName, bytes }, location.origin, [bytes])
	collab.start(seq, entries, state)
	showTitle()
}

start()

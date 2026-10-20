// Chat and calls about the open file, through Nextcloud Talk: the same conversation Talk keeps for
// the file (the one in the Files sidebar's Chat tab), shown in a panel beside the editor, with a
// button that starts or joins the file's call in a Talk window. Design: aegean-office
// docs/talk.md. The same module serves GridLogic, WordLogic and SlideLogic (`app` names the
// page); keep the copies alike.
//
// Talk's API (OCS, spreed): `file/{fileId}` (signed in) or `publicshare/{shareToken}` (a link)
// gives the conversation's token; joining it makes the person a participant; `chat/{token}`
// reads (long polling for new messages) and posts. Talk itself sends the notifications: an
// @mention in the chat and a started call reach the people in the conversation as usual. The one
// exception: someone @mentioned who wasn't in the chat yet. Talk adds them, but as having read
// that message, and drops its notification (Talk 24), so this app's /mention route tells them
// instead, with a link that opens the file with the chat open (`?chat=1`). Talk also sends no call
// notifications for a file's conversation, so a call started here is announced the same way to
// the people in the chat.

import { generateOcsUrl, generateUrl } from '@nextcloud/router'

/** How long to wait between checks for a call and unread messages, in ms. */
const ROOM_CHECK = 30000
/** How many messages to load at a time. */
const PAGE = 50
/** Messages from one person within this many seconds share one heading. */
const GROUP_SECONDS = 300
/** Talk's permission to post chat messages (constants.md, attendee permissions). */
const CAN_CHAT = 128
/** System messages worth a line in the chat; the rest (people added, settings) are Talk's own. */
const SHOWN_SYSTEM = new Set(['call_started', 'call_ended', 'call_ended_everyone', 'call_missed', 'history_cleared'])
/** Rich-object types that name a person or everyone: drawn as mentions. */
const PERSON_TYPES = new Set(['user', 'guest', 'call', 'group', 'user-group', 'federated_user', 'circle', 'team', 'email'])

/** Whether this Nextcloud has Talk, from the capabilities the page carries. */
async function talkInstalled(headers) {
	const embedded = document.getElementById('initial-state-core-capabilities')
	if (embedded?.value) {
		try {
			return Boolean(JSON.parse(atob(embedded.value))?.spreed)
		} catch {
			// Read them from the server instead.
		}
	}
	try {
		const response = await fetch(generateOcsUrl('cloud/capabilities'), { headers: headers(), credentials: 'same-origin' })
		const data = await response.json()
		return Boolean(data?.ocs?.data?.capabilities?.spreed)
	} catch {
		return false
	}
}

/** `el('div', {className: 'x'}, child, 'text')` */
function el(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props)
	node.append(...children.filter((c) => c !== null && c !== undefined && c !== false))
	return node
}

function initialsOf(name) {
	const parts = String(name).trim().split(/\s+/).filter(Boolean)
	return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Text with its web addresses as links. */
function linkify(text) {
	const out = []
	const pattern = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/gi
	let last = 0
	for (const match of text.matchAll(pattern)) {
		out.push(text.slice(last, match.index))
		out.push(el('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer', textContent: match[0] }))
		last = match.index + match[0].length
	}
	out.push(text.slice(last))
	return out
}

function sameDay(a, b) {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayLabel(date) {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	if (sameDay(date, today)) {
		return 'Today'
	}
	if (sameDay(date, yesterday)) {
		return 'Yesterday'
	}
	return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function timeLabel(date) {
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** A random reference id, so a message this page posted is known when it comes back. */
function referenceId() {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Adds chat and calls about the file to the editor page.
 *
 * - `app`: the Nextcloud app id (`gridcraft`, `wordcraft`, `deckcraft`), for element ids.
 * - `bar`: the element above the editor that takes the Chat and Call buttons.
 * - `stage`: the element the editor's iframe is in; the panel goes beside the iframe.
 * - `fileId`: the file's id (signed in); `shareToken` (and `sharePath`): a shared link's.
 * - `guestName`: the name a guest on a link gave Nextcloud, if any.
 * - `openChat`: open the panel at once (a chat mention's link).
 * - `fileName()`: the file's name as it is now.
 * - `headers()`: request headers with the request token.
 */
export async function mountTalk({ app, bar, stage, fileId, shareToken = '', sharePath = '', guestName = '', openChat = false, fileName, headers }) {
	if (!bar || !stage || (!fileId && !shareToken)) {
		return
	}
	// A link to a folder: Talk keeps conversations for files shared on their own, not for the
	// files in a shared folder.
	if (shareToken && sharePath) {
		return
	}
	if (!(await talkInstalled(headers))) {
		return
	}
	const panel = new TalkPanel({ app, bar, stage, fileId, shareToken, guestName, fileName, headers })
	if (openChat) {
		panel.toggle(true)
	}
}

class TalkPanel {
	constructor(options) {
		Object.assign(this, options)
		/** The conversation's token once known. */
		this.token = ''
		/** The conversation as Talk last described it (`room/{token}`). */
		this.room = null
		/** Messages by id. */
		this.messages = new Map()
		this.newest = 0
		this.oldest = 0
		this.hasOlder = true
		this.open = false
		/** Why there's no chat (not shared, Talk turned off, …), or ''. */
		this.unavailable = ''
		/** Mentions picked in the box being typed: label → `{id, user}` (`@"id"` for Talk; a user's uid). */
		this.picked = new Map()
		this.poll = null
		this.backoff = 0

		this.buildButtons()
		this.buildPanel()
		this.start()
	}

	ocs(path, params) {
		return generateOcsUrl(`apps/spreed/api/${path}`, params)
	}

	/** An OCS request to Talk. Resolves to `{status, data, headers}`. */
	async request(url, { method = 'GET', query, body, signal } = {}) {
		const target = new URL(url, location.href)
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) {
				target.searchParams.set(key, String(value))
			}
		}
		const init = {
			method,
			signal,
			credentials: 'same-origin',
			headers: headers(this, body),
		}
		if (body !== undefined) {
			init.body = JSON.stringify(body)
		}
		const response = await fetch(target, init)
		let data = null
		if (response.status !== 304) {
			try {
				data = (await response.json())?.ocs?.data ?? null
			} catch {
				data = null
			}
		}
		return { status: response.status, data, headers: response.headers }
	}

	// --- What the page shows ---

	buildButtons() {
		const chat = el('button', { type: 'button', className: 'aegean-talk-button chat', title: 'Chat about this file with the people it is shared with' })
		chat.setAttribute('aria-pressed', 'false')
		chat.append(el('span', { className: 'icon icon-comment', ariaHidden: 'true' }), el('span', { textContent: 'Chat' }))
		this.badge = el('span', { className: 'badge', hidden: true })
		chat.append(this.badge)
		chat.addEventListener('click', () => this.toggle())

		const call = el('button', { type: 'button', className: 'aegean-talk-button call', hidden: true })
		call.append(el('span', { className: 'icon icon-video', ariaHidden: 'true' }), el('span', { className: 'label', textContent: 'Call' }))
		call.addEventListener('click', () => this.call())

		this.chatButton = chat
		this.callButton = call
		this.actions = el('span', { className: 'aegean-talk-actions' }, call, chat)
		this.bar.append(this.actions)
		this.bar.hidden = false
	}

	buildPanel() {
		this.list = el('div', { className: 'aegean-talk-messages' })
		this.list.setAttribute('role', 'log')
		this.list.setAttribute('aria-live', 'polite')
		this.list.addEventListener('scroll', () => {
			if (this.list.scrollTop < 40) {
				this.loadOlder()
			}
		})
		this.state = el('p', { className: 'aegean-talk-state', hidden: true })

		this.box = el('textarea', { rows: 1, placeholder: 'Write a message…', maxLength: 32000 })
		this.box.setAttribute('aria-label', 'Message')
		this.box.addEventListener('keydown', (event) => this.keydown(event))
		this.box.addEventListener('input', () => {
			this.fit()
			this.suggest()
		})
		this.box.addEventListener('blur', () => setTimeout(() => this.closeSuggestions(), 150))
		this.send = el('button', { type: 'submit', className: 'send', title: 'Send (Enter)', textContent: 'Send' })
		this.suggestions = el('ul', { className: 'aegean-talk-suggestions', hidden: true })
		this.suggestions.setAttribute('role', 'listbox')
		this.form = el('form', { className: 'aegean-talk-compose' }, this.suggestions, this.box, this.send)
		this.form.addEventListener('submit', (event) => {
			event.preventDefault()
			this.post()
		})

		const close = el('button', { type: 'button', className: 'close', title: 'Close chat', textContent: '×' })
		close.setAttribute('aria-label', 'Close chat')
		close.addEventListener('click', () => this.toggle(false))
		this.openInTalk = el('a', { className: 'open-in-talk', target: '_blank', rel: 'noopener', textContent: 'Open in Talk', hidden: true })
		this.heading = el('h2', { textContent: 'Chat' })
		const header = el('header', {}, this.heading, this.openInTalk, close)

		this.panel = el('aside', { id: `${this.app}-talk`, className: 'aegean-talk-panel', hidden: true }, header, this.state, this.list, this.form)
		this.panel.setAttribute('aria-label', 'Chat about this file')
		this.panel.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && this.suggestions.hidden) {
				this.toggle(false)
			}
		})
		this.stage.append(this.panel)
	}

	showState(text) {
		this.state.textContent = text
		this.state.hidden = !text
	}

	fit() {
		this.box.style.height = 'auto'
		this.box.style.height = `${Math.min(this.box.scrollHeight + 2, 160)}px`
		this.box.style.overflowY = this.box.scrollHeight > 160 ? 'auto' : 'hidden'
	}

	toggle(open = !this.open) {
		this.open = open
		this.panel.hidden = !open
		this.chatButton.setAttribute('aria-pressed', String(open))
		if (open) {
			this.heading.textContent = `Chat · ${this.fileName()}`
			this.markUnread()
			this.render()
			this.showBadge()
			if (!this.token) {
				this.start()
			} else {
				this.listen()
			}
			this.markRead()
			this.box.focus()
		} else {
			this.stopListening()
		}
	}

	/** "New messages" goes above what was unread when the chat opened, not what comes in after. */
	markUnread() {
		this.firstUnread = (this.room?.unreadMessages ?? 0) > 0 ? this.room.lastReadMessage : 0
	}

	showBadge() {
		const unread = this.open ? 0 : (this.room?.unreadMessages ?? 0)
		this.badge.hidden = unread === 0
		this.badge.textContent = unread > 99 ? '99+' : String(unread)
		this.badge.classList.toggle('mention', Boolean(this.room?.unreadMention))
		this.chatButton.title = unread
			? `${unread} unread message${unread === 1 ? '' : 's'} about this file`
			: 'Chat about this file with the people it is shared with'
	}

	showCall() {
		const available = Boolean(this.token) && !this.unavailable
		this.callButton.hidden = !available
		const live = Boolean(this.room?.hasCall)
		this.callButton.classList.toggle('live', live)
		this.callButton.querySelector('.label').textContent = live ? 'Join call' : 'Call'
		this.callButton.title = live
			? 'A call about this file is going on: join it'
			: 'Start a call about this file (opens a Talk window)'
	}

	// --- The conversation ---

	/** Finds the file's conversation and joins it. */
	async start() {
		if (this.starting) {
			return this.starting
		}
		this.starting = (async () => {
			try {
				await this.findConversation()
				if (this.token) {
					await this.join()
					await this.refreshRoom()
					if (this.open) {
						this.listen()
					}
				}
			} catch (e) {
				console.warn('Talk:', e)
				this.unavailable = 'The chat could not be reached. Try again in a moment.'
			} finally {
				this.starting = null
				this.render()
				this.showCall()
				this.scheduleRoomCheck()
			}
		})()
		return this.starting
	}

	async findConversation() {
		const { status, data } = this.shareToken
			? await this.request(this.ocs('v1/publicshare/{shareToken}', { shareToken: this.shareToken }))
			: await this.request(this.ocs('v1/file/{fileId}', { fileId: this.fileId }))
		if (status === 200 && data?.token) {
			this.token = data.token
			this.unavailable = ''
			this.openInTalk.href = generateUrl('/call/{token}', { token: this.token })
			this.openInTalk.hidden = Boolean(this.shareToken)
			return
		}
		this.token = ''
		this.unavailable = status === 404
			? (this.shareToken
				? 'There is no chat for this link.'
				: 'Share this file with someone to chat about it. The people it is shared with see the chat here and in Talk.')
			: status === 400
				? 'Chat about files is turned off on this Nextcloud.'
				: 'The chat could not be reached. Try again in a moment.'
	}

	/** Joins the conversation: a signed-in person becomes one of its participants. */
	async join() {
		// Not forced: a Talk window this browser has in the file's call keeps its place (409).
		const { status } = await this.request(this.ocs('v4/room/{token}/participants/active', { token: this.token }), {
			method: 'POST',
			body: { force: false },
		})
		if (status !== 200 && status !== 409) {
			throw new Error(`Talk did not let this page join the chat (${status})`)
		}
		if (this.shareToken && this.guestName) {
			await this.request(this.ocs('v1/guest/{token}/name', { token: this.token }), {
				method: 'POST',
				body: { displayName: this.guestName },
			}).catch(() => {})
		}
	}

	async refreshRoom() {
		if (!this.token) {
			return
		}
		const { status, data } = await this.request(this.ocs('v4/room/{token}', { token: this.token }))
		if (status === 200 && data) {
			this.room = data
		} else if (status === 404) {
			// The file was unshared, or the conversation was removed.
			this.lost()
		}
		this.showBadge()
		this.showCall()
		this.showComposer()
	}

	lost() {
		this.token = ''
		this.room = null
		this.messages.clear()
		this.newest = this.oldest = 0
		this.hasOlder = true
		this.stopListening()
		this.unavailable = 'Share this file with someone to chat about it. The people it is shared with see the chat here and in Talk.'
		this.render()
	}

	scheduleRoomCheck() {
		clearTimeout(this.roomTimer)
		this.roomTimer = setTimeout(async () => {
			try {
				if (this.token) {
					await this.refreshRoom()
				} else if (!this.starting) {
					// Shared since: the chat appears without reloading.
					await this.findConversation()
					if (this.token) {
						await this.join()
						await this.refreshRoom()
						this.render()
						if (this.open) {
							this.listen()
						}
					}
				}
			} catch (e) {
				console.warn('Talk:', e)
			}
			this.scheduleRoomCheck()
		}, document.visibilityState === 'visible' ? ROOM_CHECK : ROOM_CHECK * 4)
	}

	showComposer() {
		const permissions = this.room?.permissions ?? CAN_CHAT
		const readOnly = this.room?.readOnly === 1
		const canPost = Boolean(this.token) && !readOnly && (permissions & CAN_CHAT) !== 0
		this.form.hidden = !this.token
		this.box.disabled = !canPost
		this.send.disabled = !canPost
		this.box.placeholder = canPost ? 'Write a message…' : 'You can read this chat but not post in it.'
	}

	// --- Messages ---

	/** Loads the latest messages, then keeps waiting for new ones while the panel is open. */
	async listen() {
		if (this.poll || !this.token) {
			return
		}
		const controller = new AbortController()
		this.poll = controller
		try {
			if (this.newest === 0) {
				await this.loadLatest(controller.signal)
			}
			while (this.poll === controller && this.token) {
				const { status, data, headers: responseHeaders } = await this.request(this.ocs('v1/chat/{token}', { token: this.token }), {
					signal: controller.signal,
					query: {
						lookIntoFuture: 1,
						lastKnownMessageId: this.newest,
						limit: 100,
						timeout: 30,
						setReadMarker: 0,
						markNotificationsAsRead: 0,
						includeLastKnown: 0,
					},
				})
				if (status === 200 && Array.isArray(data)) {
					this.add(data)
					const given = Number(responseHeaders.get('X-Chat-Last-Given'))
					if (given > this.newest) {
						this.newest = given
					}
					this.markRead()
				} else if (status === 404) {
					this.lost()
					break
				} else if (status !== 304) {
					throw new Error(`Talk answered ${status}`)
				}
				this.backoff = 0
			}
		} catch (e) {
			if (e.name !== 'AbortError') {
				console.warn('Talk chat:', e)
				this.backoff = Math.min(60000, Math.max(2000, this.backoff * 2))
				setTimeout(() => {
					if (this.poll === controller) {
						this.poll = null
						this.listen()
					}
				}, this.backoff)
				return
			}
		}
		if (this.poll === controller) {
			this.poll = null
		}
	}

	stopListening() {
		this.poll?.abort()
		this.poll = null
	}

	async loadLatest(signal) {
		const { status, data, headers: responseHeaders } = await this.request(this.ocs('v1/chat/{token}', { token: this.token }), {
			signal,
			query: { lookIntoFuture: 0, limit: PAGE, setReadMarker: 0, markNotificationsAsRead: 0, includeLastKnown: 0 },
		})
		if (status === 200 && Array.isArray(data)) {
			this.markUnread()
			this.add(data)
			this.oldest = Number(responseHeaders.get('X-Chat-Last-Given')) || this.oldest
			this.hasOlder = data.length >= PAGE
		} else {
			this.hasOlder = false
		}
		this.newest = Math.max(this.newest, ...Array.from(this.messages.keys()), 0)
		this.render()
		this.list.scrollTop = this.list.scrollHeight
		this.markRead()
	}

	async loadOlder() {
		if (!this.hasOlder || this.loadingOlder || !this.token || !this.oldest) {
			return
		}
		this.loadingOlder = true
		try {
			const { status, data, headers: responseHeaders } = await this.request(this.ocs('v1/chat/{token}', { token: this.token }), {
				query: { lookIntoFuture: 0, limit: PAGE, lastKnownMessageId: this.oldest, setReadMarker: 0, markNotificationsAsRead: 0, includeLastKnown: 0 },
			})
			if (status === 200 && Array.isArray(data)) {
				const before = this.list.scrollHeight
				this.add(data, false)
				this.oldest = Number(responseHeaders.get('X-Chat-Last-Given')) || this.oldest
				this.hasOlder = data.length >= PAGE
				this.render()
				// Keep the messages being read where they were.
				this.list.scrollTop += this.list.scrollHeight - before
			} else {
				this.hasOlder = false
			}
		} finally {
			this.loadingOlder = false
		}
	}

	/** Takes messages from Talk: new ones, and edits and deletions of ones shown. */
	add(messages, render = true) {
		const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60
		for (const message of messages) {
			if (message.systemMessage === 'message_edited' || message.systemMessage === 'message_deleted') {
				if (message.parent?.id && this.messages.has(message.parent.id)) {
					this.messages.set(message.parent.id, message.parent)
				}
				continue
			}
			if (message.systemMessage === 'history_cleared') {
				this.messages.clear()
			}
			this.messages.set(message.id, message)
		}
		if (render) {
			this.render()
			if (atBottom) {
				this.list.scrollTop = this.list.scrollHeight
			}
		}
	}

	shown(message) {
		if (message.messageType === 'system') {
			return SHOWN_SYSTEM.has(message.systemMessage)
		}
		if (message.expirationTimestamp && message.expirationTimestamp * 1000 < Date.now()) {
			return false
		}
		return message.messageType === 'comment' || message.messageType === 'comment_deleted' || message.messageType === 'voice-message' || message.messageType === 'record-audio' || message.messageType === 'record-video'
	}

	isMine(message) {
		return Boolean(this.room) && message.actorType === this.room.actorType && message.actorId === this.room.actorId
	}

	/** A message's text with its people, files and links filled in. */
	richText(message) {
		const params = message.messageParameters ?? {}
		const parts = []
		const pattern = /\{([a-z0-9_-]+)\}/gi
		const text = String(message.message ?? '')
		let last = 0
		for (const match of text.matchAll(pattern)) {
			const param = params[match[1]]
			if (!param) {
				continue
			}
			parts.push(...linkify(text.slice(last, match.index)))
			parts.push(this.richObject(param))
			last = match.index + match[0].length
		}
		parts.push(...linkify(text.slice(last)))
		return parts
	}

	richObject(param) {
		const name = String(param.name ?? param.id ?? '')
		if (PERSON_TYPES.has(param.type)) {
			const mention = el('span', { className: 'mention', textContent: `@${name}` })
			const me = this.room
				&& ((param.type === 'user' && this.room.actorType === 'users' && param.id === this.room.actorId)
					|| (param.type === 'guest' && this.room.actorType === 'guests' && String(param.id).replace(/^guest\//, '') === this.room.actorId)
					|| param.type === 'call')
			mention.classList.toggle('me', Boolean(me))
			return mention
		}
		if (param.link) {
			return el('a', { href: param.link, target: '_blank', rel: 'noopener noreferrer', textContent: name })
		}
		return name
	}

	avatar(message) {
		const name = message.actorDisplayName || (message.actorType === 'guests' ? 'Guest' : message.actorId)
		if (message.actorType === 'users') {
			const img = el('img', { className: 'avatar', alt: '', loading: 'lazy', src: generateUrl('/avatar/{user}/64', { user: message.actorId }) })
			img.addEventListener('error', () => img.replaceWith(el('span', { className: 'avatar initials', textContent: initialsOf(name) })))
			return img
		}
		return el('span', { className: 'avatar initials', textContent: initialsOf(name) })
	}

	render() {
		if (!this.token) {
			this.list.replaceChildren()
			this.showState(this.starting ? 'Opening the chat…' : this.unavailable)
			this.showComposer()
			return
		}
		const shown = Array.from(this.messages.values()).filter((m) => this.shown(m)).sort((a, b) => a.id - b.id)
		this.showState(shown.length === 0 && !this.hasOlder
			? 'No messages yet. Say something to the people this file is shared with; @ mentions them.'
			: '')
		const nodes = []
		if (this.hasOlder && shown.length > 0) {
			nodes.push(el('p', { className: 'aegean-talk-more', textContent: 'Scroll up for earlier messages' }))
		}
		let previous = null
		let unreadMarked = false
		for (const message of shown) {
			const date = new Date(message.timestamp * 1000)
			if (!previous || !sameDay(new Date(previous.timestamp * 1000), date)) {
				nodes.push(el('p', { className: 'aegean-talk-day', textContent: dayLabel(date) }))
				previous = null
			}
			if (!unreadMarked && this.firstUnread && message.id > this.firstUnread && !this.isMine(message)) {
				nodes.push(el('p', { className: 'aegean-talk-unread', textContent: 'New messages' }))
				unreadMarked = true
				previous = null
			}
			if (message.messageType === 'system') {
				nodes.push(el('p', { className: 'aegean-talk-system' }, ...this.richText(message), ` · ${timeLabel(date)}`))
				previous = null
				continue
			}
			const grouped = previous
				&& previous.actorType === message.actorType
				&& previous.actorId === message.actorId
				&& message.timestamp - previous.timestamp < GROUP_SECONDS
			const body = message.messageType === 'comment_deleted'
				? el('div', { className: 'text deleted', textContent: 'Message deleted' })
				: el('div', { className: 'text' }, ...this.richText(message))
			if (message.lastEditTimestamp && message.messageType !== 'comment_deleted') {
				body.append(el('span', { className: 'edited', textContent: ' (edited)' }))
			}
			const item = el('div', { className: `aegean-talk-message${grouped ? ' grouped' : ''}${this.isMine(message) ? ' mine' : ''}` })
			item.dataset.id = String(message.id)
			if (grouped) {
				item.append(el('span', { className: 'avatar-space' }), el('div', { className: 'body' }, body))
				item.title = timeLabel(date)
			} else {
				const name = message.actorDisplayName || (message.actorType === 'guests' ? 'Guest' : message.actorId)
				const head = el('div', { className: 'head' }, el('strong', { textContent: name }), el('time', { dateTime: date.toISOString(), textContent: timeLabel(date) }))
				item.append(this.avatar(message), el('div', { className: 'body' }, head, body))
			}
			nodes.push(item)
			previous = message
		}
		this.list.replaceChildren(...nodes)
		this.showComposer()
	}

	/** Tells Talk the person has read up to the newest message, while they can see the panel. */
	async markRead() {
		if (!this.open || !this.token || !this.newest || document.visibilityState !== 'visible') {
			return
		}
		if (this.room && this.room.lastReadMessage >= this.newest) {
			this.showBadge()
			return
		}
		// Guests have no read marker in Talk.
		if (!this.room || this.room.actorType !== 'users') {
			return
		}
		const { status } = await this.request(this.ocs('v1/chat/{token}/read', { token: this.token }), {
			method: 'POST',
			body: { lastReadMessage: this.newest },
		}).catch(() => ({ status: 0 }))
		if (status === 200 && this.room) {
			this.room.lastReadMessage = this.newest
			this.room.unreadMessages = 0
			this.room.unreadMention = false
		}
		this.showBadge()
	}

	/** Posts what's in the box. `@Name` picked from the list goes to Talk as a mention. */
	async post() {
		let text = this.box.value.trim()
		if (!text || !this.token || this.box.disabled || this.sending) {
			return
		}
		const shown = text
		const mentioned = []
		const labels = Array.from(this.picked.keys()).sort((a, b) => b.length - a.length)
		for (const label of labels) {
			const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			const pattern = new RegExp(`@${escaped}(?=$|[\\s.,;:!?)])`, 'g')
			const { id, user } = this.picked.get(label)
			const replaced = text.replace(pattern, `@"${id}"`)
			if (user && replaced !== text) {
				mentioned.push(user)
			}
			text = replaced
		}
		this.sending = true
		this.send.disabled = true
		try {
			const newcomers = await this.notInChat(mentioned)
			const { status, data } = await this.request(this.ocs('v1/chat/{token}', { token: this.token }), {
				method: 'POST',
				body: { message: text, referenceId: referenceId(), actorDisplayName: this.guestName || undefined },
			})
			if (status === 201 || status === 200) {
				this.box.value = ''
				this.picked.clear()
				this.firstUnread = 0
				this.fit()
				if (data?.id) {
					this.add([data])
					this.newest = Math.max(this.newest, data.id)
					this.list.scrollTop = this.list.scrollHeight
				}
				this.markRead()
				this.tellNewcomers(newcomers, shown)
			} else if (status === 413) {
				this.showState('That message is too long.')
			} else if (status === 404) {
				this.lost()
			} else {
				this.showState(`The message wasn't sent (Talk answered ${status}). Try again.`)
			}
		} catch {
			this.showState("The message wasn't sent: Nextcloud couldn't be reached. Try again.")
		} finally {
			this.sending = false
			this.showComposer()
			this.box.focus()
		}
	}

	/** Which of these users aren't in the chat yet (signed in, on the file's own page). */
	async notInChat(uids) {
		if (uids.length === 0 || this.shareToken || !this.fileId) {
			return []
		}
		const { status, data } = await this.request(this.ocs('v4/room/{token}/participants', { token: this.token }))
			.catch(() => ({ status: 0 }))
		if (status !== 200 || !Array.isArray(data)) {
			return []
		}
		const inChat = new Set(data.filter((p) => p.actorType === 'users').map((p) => p.actorId))
		return uids.filter((uid) => !inChat.has(uid))
	}

	/** Tells people a message brought into the chat that they were mentioned (see the top). */
	tellNewcomers(uids, text) {
		return this.tell(uids, text, 'chat')
	}

	/** Has this app notify Nextcloud users about the chat (`where`: `chat` or `call`). */
	async tell(uids, text, where) {
		if (uids.length === 0) {
			return
		}
		try {
			await fetch(generateUrl('/apps/{app}/mention', { app: this.app }), {
				method: 'POST',
				credentials: 'same-origin',
				headers: { ...this.headers(), 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileId: this.fileId, people: uids.slice(0, 20), text: text.slice(0, 1000), where }),
			})
		} catch (e) {
			console.warn('Talk: people were not told', e)
		}
	}

	// --- @mentions while typing ---

	/** The `@word` just before the caret, if any. */
	mentionQuery() {
		const before = this.box.value.slice(0, this.box.selectionStart)
		const match = /(^|\s)@([^\s@]{0,40})$/.exec(before)
		return match ? { query: match[2], start: before.length - match[2].length - 1 } : null
	}

	suggest() {
		clearTimeout(this.suggestTimer)
		const found = this.mentionQuery()
		if (!found || !this.token) {
			this.closeSuggestions()
			return
		}
		this.suggestTimer = setTimeout(async () => {
			const { status, data } = await this.request(this.ocs('v1/chat/{token}/mentions', { token: this.token }), {
				query: { search: found.query, limit: 8, includeStatus: 0 },
			}).catch(() => ({ status: 0 }))
			if (status !== 200 || !Array.isArray(data) || data.length === 0 || !this.mentionQuery()) {
				this.closeSuggestions()
				return
			}
			this.choices = data
			this.choice = 0
			this.showSuggestions()
		}, 150)
	}

	showSuggestions() {
		this.suggestions.replaceChildren(...this.choices.map((option, i) => {
			const item = el('li', {
				className: i === this.choice ? 'chosen' : '',
				textContent: option.label,
			})
			item.setAttribute('role', 'option')
			item.setAttribute('aria-selected', String(i === this.choice))
			if (option.source === 'calls') {
				item.append(el('small', { textContent: ' everyone in this chat' }))
			}
			item.addEventListener('mousedown', (event) => {
				event.preventDefault()
				this.pick(option)
			})
			return item
		}))
		this.suggestions.hidden = false
	}

	closeSuggestions() {
		this.suggestions.hidden = true
		this.choices = null
	}

	pick(option) {
		const found = this.mentionQuery()
		if (!found) {
			return
		}
		const id = option.mentionId
			?? (option.source === 'guests' ? `guest/${option.id}` : option.source === 'calls' ? 'all' : option.id)
		const label = option.source === 'calls' ? 'all' : option.label
		this.picked.set(label, { id, user: option.source === 'users' ? option.id : '' })
		const value = this.box.value
		const caret = this.box.selectionStart
		const insert = `@${label} `
		this.box.value = value.slice(0, found.start) + insert + value.slice(caret)
		const at = found.start + insert.length
		this.box.setSelectionRange(at, at)
		this.closeSuggestions()
		this.fit()
	}

	keydown(event) {
		if (this.choices && !this.suggestions.hidden) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault()
				const n = this.choices.length
				this.choice = (this.choice + (event.key === 'ArrowDown' ? 1 : n - 1)) % n
				this.showSuggestions()
				return
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault()
				this.pick(this.choices[this.choice])
				return
			}
			if (event.key === 'Escape') {
				event.preventDefault()
				this.closeSuggestions()
				return
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault()
			this.post()
		}
	}

	// --- Calls ---

	/** Starts or joins the file's call in a Talk window beside the editor. */
	call() {
		if (!this.token) {
			return
		}
		// `#direct-call`: Talk goes straight to joining (its device check first, as it chooses).
		const url = `${generateUrl('/call/{token}', { token: this.token })}#direct-call`
		const width = Math.min(1100, Math.max(640, Math.round(screen.availWidth * 0.5)))
		const height = Math.min(800, Math.max(480, Math.round(screen.availHeight * 0.75)))
		const starting = !this.room?.hasCall
		const opened = window.open(url, `talk-${this.token}`, `popup,width=${width},height=${height}`)
		if (!opened) {
			// A blocked pop-up: a new tab instead.
			window.open(url, '_blank', 'noopener')
		}
		this.watchCall(starting)
	}

	/**
	 * Follows the call for a minute after the button: shows it going on, and when this person
	 * started it, tells the people in the chat who aren't in it (see the top).
	 */
	watchCall(starting) {
		clearInterval(this.callWatch)
		let tries = 0
		this.callWatch = setInterval(async () => {
			tries++
			try {
				await this.refreshRoom()
			} catch {
				// Tried again in a moment.
			}
			const live = Boolean(this.room?.hasCall)
			if (live || tries >= 20) {
				clearInterval(this.callWatch)
			}
			if (starting && live && !this.shareToken && this.fileId) {
				const { status, data } = await this.request(this.ocs('v4/room/{token}/participants', { token: this.token }))
					.catch(() => ({ status: 0 }))
				if (status === 200 && Array.isArray(data)) {
					const away = data
						.filter((p) => p.actorType === 'users' && p.actorId !== this.room.actorId && !p.inCall)
						.map((p) => p.actorId)
					this.tell(away, '', 'call')
				}
			}
		}, 3000)
	}
}

/** Request headers for Talk's OCS API: JSON in and out, the page's request token. */
function headers(panel, body) {
	return {
		...panel.headers(),
		'OCS-APIRequest': 'true',
		Accept: 'application/json',
		...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
	}
}

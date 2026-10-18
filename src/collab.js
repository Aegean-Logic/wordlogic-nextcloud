// Co-editing for the editor page. WordLogic (in the iframe) does all the merging; this module
// carries ops between it and the app's sequencer (`/apps/wordcraft/collab/*`, or through a
// shared link `/apps/wordcraft/s/{token}/collab/*`) and saves the shared document back to the
// file now and then (a checkpoint), with WordLogic's snapshot of it, so the file keeps up and
// people joining later start from exactly the shared document. Protocol: README.md, "Protocol".

/** Save the shared document after this many log entries… */
const CHECKPOINT_OPS = 20
/** …or this long after the first unsaved one. */
const CHECKPOINT_MS = 30_000
/** Colours for the people in a session, by client id: legible under white text. */
const COLORS = ['#C0392B', '#1F6FB2', '#8E44AD', '#B9770E', '#148F77', '#AD1457', '#2E7D32', '#6D4C41']

/** The colour a member is drawn in, in the document and in the list of who's editing. */
export function colorFor(client) {
	return COLORS[(Number(client) - 1) % COLORS.length] ?? COLORS[0]
}

/** How often to ask for others' edits while the tab is visible, and while it's hidden. */
const POLL_MS = 600
const POLL_HIDDEN_MS = 3000

export class Collab {
	/**
	 * @param {object} o
	 * @param {HTMLIFrameElement} o.frame WordLogic
	 * @param {number} o.fileId
	 * @param {string} o.fileUrl WebDAV URL of the file
	 * @param {(extra?: object) => object} o.headers request headers (with the request token)
	 * @param {(text: string, error?: boolean) => void} o.notify a message for the person
	 * @param {(members: object[]) => void} o.onMembers who's in the session
	 * @param {string} o.endpoint the sequencer's URL (`…/collab`)
	 * @param {string} o.person how the others see this person
	 * @param {object} o.joinParams more for joining (a link visitor's name)
	 */
	constructor({ frame, fileId, fileUrl, headers, notify, onMembers, endpoint, person, joinParams = {} }) {
		Object.assign(this, { frame, fileId, fileUrl, headers, notify, onMembers, endpoint, person, joinParams })
		/** A link visitor's proof of membership, from joining (sent with every call). */
		this.key = ''
		this.sessionId = 0
		this.client = 0
		this.lastSeq = 0
		this.checkpointSeq = 0
		this.checkpointEtag = ''
		this.firstUnsavedAt = 0
		this.members = []
		this.outbox = []
		this.sending = false
		this.saving = null
		this.checkpointId = 0
		this.waiting = new Map()
		this.stopped = false
		this.canEdit = true
		/** This person's position from WordLogic (JSON), and the one the server has. */
		this.selection = ''
		this.sentSelection = ''
	}

	/**
	 * Loads the file and joins its session. Resolves once WordLogic can open the file: its bytes,
	 * the log position it's at, the state snapshot kept for that position ('' if none: the file
	 * itself is the shared document), and the log entries after it.
	 */
	async join() {
		for (let attempt = 0; attempt < 6; attempt++) {
			// Never from the browser's cache: Nextcloud doesn't say how long a file may be kept, and a
			// stale copy has an old ETag (the join would be retried forever).
			const response = await fetch(this.fileUrl, { headers: this.headers(), credentials: 'same-origin', cache: 'no-store' })
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}`)
			}
			const etag = bare(response.headers.get('ETag') ?? '')
			const bytes = await response.arrayBuffer()
			const joined = await this.call('POST', 'join', { fileId: this.fileId, etag, ...this.joinParams })
			if (joined.retry) {
				// Saved for the session since this copy was fetched: fetch it again, giving a
				// save in progress time to finish.
				await sleep(400 * 2 ** attempt)
				continue
			}
			Object.assign(this, { sessionId: joined.sessionId, client: joined.client, canEdit: joined.canEdit !== false, key: joined.key ?? '' })
			let state = ''
			if (joined.hasState) {
				try {
					state = await this.state(joined.seq)
				} catch {
					// Saved again in between (that save replaced the snapshot): start over from
					// the newer file.
					await this.call('POST', 'leave', { sessionId: this.sessionId, client: this.client }).catch(() => {})
					this.sessionId = 0
					this.key = ''
					await sleep(400 * 2 ** attempt)
					continue
				}
			}
			this.checkpointSeq = joined.seq
			this.checkpointEtag = etag
			this.lastSeq = joined.seq
			this.members = joined.members ?? []
			this.onMembers(this.shownMembers())
			return { bytes, seq: joined.seq, state, entries: joined.entries ?? [] }
		}
		throw new Error('the file keeps changing; try again in a moment')
	}

	/** The state snapshot of the checkpoint at `seq` (text, as WordLogic handed it over). */
	async state(seq) {
		const params = this.withKey({ sessionId: this.sessionId, client: this.client, seq })
		const response = await fetch(`${this.endpoint}/state?${new URLSearchParams(params)}`, {
			credentials: 'same-origin',
			headers: this.headers({ Accept: 'application/json' }),
		})
		if (!response.ok) {
			throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status })
		}
		return response.text()
	}

	/**
	 * After WordLogic opened the file: start sharing and catching up. `state`: the shared
	 * document as of `seq`, which WordLogic takes instead of the file just opened ('' for none).
	 */
	start(seq, entries, state = '') {
		const message = {
			type: 'wordcraft:collab:start',
			client: this.client,
			clientId: this.client,
			seq,
			readOnly: !this.canEdit,
			user: this.person,
			color: colorFor(this.client),
		}
		if (state) {
			message.state = state
		}
		this.post(message)
		this.deliver(entries)
		if (!this.canEdit) {
			this.notify('You can view this file but not edit it.')
		}
		addEventListener('pagehide', () => this.leave())
		this.poll()
	}

	/** An op from WordLogic, for the server. */
	queue(json) {
		if (this.stopped) {
			return
		}
		let out
		try {
			out = JSON.parse(json)
		} catch {
			return
		}
		this.outbox.push({ clientSeq: out.client_seq, base: out.base, op: JSON.stringify(out.op) })
		this.flush()
	}

	/** Sends queued ops in order, retrying the first until it's through. */
	async flush() {
		if (this.sending) {
			return
		}
		this.sending = true
		while (this.outbox.length && !this.stopped) {
			const next = this.outbox[0]
			try {
				await this.call('POST', 'push', { sessionId: this.sessionId, client: this.client, ...next })
				this.outbox.shift()
			} catch (e) {
				if (e.status === 403) {
					this.notify('You can view this file but not edit it: your changes aren\'t shared.', true)
					this.outbox.length = 0
				} else if (e.status === 409) {
					this.rejoin()
				} else if (e.status === 400) {
					// Refused for good (too large, or malformed): retrying can't help, and this
					// copy now differs from everyone else's, so start again from the file.
					this.notify(`An edit couldn't be shared: ${e.message}`, true)
					this.outbox.length = 0
					this.rejoin()
				} else {
					// Offline or a hiccup: the server recognises a retried op, so try again.
					await sleep(1000)
				}
			}
		}
		this.sending = false
	}

	/** Asks for others' edits, forever. */
	async poll() {
		while (!this.stopped) {
			try {
				const sel = this.selection !== this.sentSelection ? this.selection : ''
				const r = await this.call('GET', 'sync', { sessionId: this.sessionId, client: this.client, since: this.lastSeq, sel })
				if (r.rejoin) {
					this.rejoin()
					return
				}
				if (sel) {
					this.sentSelection = sel
				}
				this.deliver(r.entries ?? [])
				this.checkpointSeq = Math.max(this.checkpointSeq, r.checkpointSeq ?? 0)
				if (r.checkpointEtag) {
					this.checkpointEtag = r.checkpointEtag
				}
				this.members = r.members ?? []
				this.onMembers(this.shownMembers())
				this.showOthers()
				this.maybeCheckpoint()
				if ((r.entries ?? []).length) {
					continue
				}
			} catch (e) {
				if (e.status === 409) {
					this.rejoin()
					return
				}
			}
			await sleep(document.hidden ? POLL_HIDDEN_MS : POLL_MS)
		}
	}

	/** This person's position from WordLogic, for the others (sent with the next poll). */
	setSelection(json) {
		this.selection = String(json ?? '')
	}

	/**
	 * Where the others are, for WordLogic to draw in the document: each member's position as their
	 * WordLogic sent it (caret and selection; this page doesn't read it), with their name and colour.
	 */
	/** The members to show: those seen lately (one gone without leaving drops out in seconds;
	 * the full list still decides who writes checkpoints). */
	shownMembers() {
		return this.members.filter((m) => m.recent !== false || m.client === this.client)
	}

	showOthers() {
		const people = []
		for (const m of this.members) {
			if (m.client === this.client || !m.selection || m.recent === false) {
				continue
			}
			try {
				const at = JSON.parse(m.selection)
				if (at && typeof at === 'object' && !Array.isArray(at)) {
					people.push({ ...at, client: m.client, name: m.displayName || m.userId, color: colorFor(m.client) })
				}
			} catch {
				// A garbled position: leave that person out.
			}
		}
		const json = JSON.stringify(people)
		if (json !== this.shownOthers) {
			this.shownOthers = json
			this.post({ type: 'wordcraft:collab:presence', json })
		}
	}

	/** Log entries to WordLogic, as one JSON text (ops passed through untouched). */
	deliver(entries) {
		if (!entries.length) {
			return
		}
		const json = '[' + entries.map((e) => `{"seq":${e.seq},"client":${e.client},"client_seq":${e.client_seq},"base":${e.base},"op":${e.op}}`).join(',') + ']'
		this.post({ type: 'wordcraft:collab:entries', json })
		this.lastSeq = entries[entries.length - 1].seq
		if (this.lastSeq > this.checkpointSeq && !this.firstUnsavedAt) {
			this.firstUnsavedAt = Date.now()
		}
	}

	/** Edits since the file was last saved for the session. */
	get unsaved() {
		return this.lastSeq > this.checkpointSeq || this.outbox.length > 0
	}

	/** The editor with the lowest client id saves, when enough has changed. */
	maybeCheckpoint() {
		const editors = this.members.filter((m) => m.canEdit !== false)
		const writer = editors.length ? Math.min(...editors.map((m) => m.client)) : this.client
		const due = this.lastSeq - this.checkpointSeq >= CHECKPOINT_OPS || (this.firstUnsavedAt && Date.now() - this.firstUnsavedAt >= CHECKPOINT_MS)
		if (writer === this.client && this.lastSeq > this.checkpointSeq && due && this.canEdit) {
			this.checkpoint().catch((e) => console.warn('WordLogic: checkpoint failed', e))
		}
	}

	/** Saves the shared document to the file now (Save, or a periodic checkpoint). */
	checkpoint() {
		if (!this.saving) {
			this.saving = this.writeCheckpoint().finally(() => {
				this.saving = null
			})
		}
		return this.saving
	}

	async writeCheckpoint() {
		const data = await this.request()
		if (data.seq <= this.checkpointSeq) {
			return
		}
		const response = await fetch(this.fileUrl, {
			method: 'PUT',
			headers: this.headers({ 'If-Match': `"${this.checkpointEtag}"` }),
			credentials: 'same-origin',
			body: data.bytes,
		})
		if (response.status === 412) {
			// Someone else in the session saved first (fine), or the file changed outside it.
			const before = this.checkpointEtag
			const r = await this.call('GET', 'sync', { sessionId: this.sessionId, client: this.client, since: this.lastSeq })
			if (r.checkpointEtag && r.checkpointEtag !== before) {
				this.checkpointEtag = r.checkpointEtag
				this.checkpointSeq = Math.max(this.checkpointSeq, r.checkpointSeq ?? 0)
				return
			}
			this.stop()
			throw new Error('The file was changed outside this editing session. Reload to see it; edits since the last save weren\'t written to it.')
		}
		if (!response.ok) {
			throw new Error(`Nextcloud answered ${response.status} ${response.statusText}`)
		}
		const etag = bare(response.headers.get('OC-ETag') ?? response.headers.get('ETag') ?? '')
		// With the snapshot of the document as saved, for people who join from this save.
		await this.call('POST', 'checkpoint', { sessionId: this.sessionId, client: this.client, seq: data.seq, etag, state: data.state })
		this.checkpointSeq = data.seq
		this.checkpointEtag = etag
		this.firstUnsavedAt = this.lastSeq > data.seq ? Date.now() : 0
	}

	/** The shared document from WordLogic: `{seq, bytes, state}`. */
	request() {
		const id = ++this.checkpointId
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject })
			this.post({ type: 'wordcraft:collab:checkpoint', id })
			setTimeout(() => {
				if (this.waiting.delete(id)) {
					reject(new Error('WordLogic didn\'t hand over the document'))
				}
			}, 30_000)
		})
	}

	/** WordLogic's answer to `request`. */
	received(message) {
		const w = this.waiting.get(message.id)
		if (w) {
			this.waiting.delete(message.id)
			const state = message.state == null ? '' : typeof message.state === 'string' ? message.state : JSON.stringify(message.state)
			w.resolve({ seq: message.seq, bytes: message.bytes, state })
		}
	}

	/** WordLogic can't follow the log (or the server forgot this copy): start again from the file. */
	rejoin() {
		if (this.stopped) {
			return
		}
		this.stop()
		this.notify('Reconnecting to the shared document…')
		setTimeout(() => location.reload(), 1500)
	}

	stop() {
		this.stopped = true
		this.post({ type: 'wordcraft:collab:stop' })
	}

	leave() {
		if (!this.sessionId) {
			return
		}
		fetch(`${this.endpoint}/leave`, {
			method: 'POST',
			keepalive: true,
			credentials: 'same-origin',
			headers: this.headers({ 'Content-Type': 'application/json' }),
			body: JSON.stringify(this.withKey({ sessionId: this.sessionId, client: this.client })),
		}).catch(() => {})
	}

	post(message) {
		this.frame.contentWindow?.postMessage(message, location.origin)
	}

	/** A call's parameters, with a link visitor's key. */
	withKey(params) {
		return this.key ? { ...params, key: this.key } : params
	}

	/** A call to the sequencer; throws an Error with `status` on failure. */
	async call(method, endpoint, params) {
		params = this.withKey(params)
		let url = `${this.endpoint}/${endpoint}`
		const init = { method, credentials: 'same-origin', headers: this.headers({ Accept: 'application/json' }) }
		if (method === 'GET') {
			url += '?' + new URLSearchParams(params).toString()
		} else {
			init.headers['Content-Type'] = 'application/json'
			init.body = JSON.stringify(params)
		}
		const response = await fetch(url, init)
		const body = await response.json().catch(() => ({}))
		if (!response.ok) {
			const e = new Error(body.error ?? `${response.status} ${response.statusText}`)
			e.status = response.status
			if (body.rejoin) {
				e.status = 409
			}
			throw e
		}
		return body
	}
}

/** An ETag without its quotes. */
function bare(etag) {
	return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

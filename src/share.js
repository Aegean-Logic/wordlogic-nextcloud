// Sharing for WordLogic's Share dialog: the dialog's operations (share.info, share.search,
// share.list, share.add, share.update, share.remove, share.link; GridLogic's Cloud), carried out
// with Nextcloud's sharing API for the file that's open. WordLogic draws the dialog; this only
// talks to Nextcloud.

import { getRequestToken } from '@nextcloud/auth'
import { generateOcsUrl } from '@nextcloud/router'

const TYPE = { user: 0, group: 1, link: 3, email: 4, remote: 6, team: 7 }
const NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]))
/** Nextcloud permission bits for a file: read, and read + update. */
const VIEW = 1
const EDIT = 3

/**
 * @param {object} o
 * @param {string} o.path the file, relative to the user's files
 * @param {string} o.name its name
 * @param {string} o.davUrl its WebDAV URL
 */
export function sharing({ path, name, davUrl }) {
	const sharePath = '/' + path.replace(/^\/+/, '')

	async function ocs(method, endpoint, params = {}) {
		let url = generateOcsUrl(`apps/files_sharing/api/v1/${endpoint}`)
		const init = {
			method,
			credentials: 'same-origin',
			headers: { requesttoken: getRequestToken() ?? '', 'OCS-APIRequest': 'true', Accept: 'application/json' },
		}
		if (method === 'GET') {
			const q = new URLSearchParams()
			for (const [k, v] of Object.entries(params)) {
				for (const item of [].concat(v)) {
					q.append(Array.isArray(v) ? `${k}[]` : k, String(item))
				}
			}
			url += (url.includes('?') ? '&' : '?') + q.toString()
		} else {
			init.headers['Content-Type'] = 'application/json'
			init.body = JSON.stringify(params)
		}
		const response = await fetch(url, init)
		const body = await response.json().catch(() => null)
		const meta = body?.ocs?.meta
		if (!response.ok || (meta && meta.statuscode >= 300)) {
			throw new Error(meta?.message || `Nextcloud answered ${response.status} ${response.statusText}`)
		}
		return body?.ocs?.data
	}

	/** A Nextcloud share as the dialog wants it. */
	function shareOf(s) {
		const type = NAME[s.share_type] ?? 'user'
		return {
			id: s.id,
			type,
			shareWith: s.share_with ?? '',
			label: s.share_with_displayname || s.share_with || '',
			edit: (Number(s.permissions) & 2) !== 0,
			url: s.url ?? null,
			password: type === 'link' ? Boolean(s.password || s.share_with) : false,
			expiration: s.expiration ? String(s.expiration).slice(0, 10) : null,
		}
	}

	async function list() {
		const data = await ocs('GET', 'shares', { path: sharePath, reshares: 'true' })
		return (data ?? []).map(shareOf)
	}

	async function canShare() {
		const response = await fetch(davUrl, {
			method: 'PROPFIND',
			credentials: 'same-origin',
			headers: { requesttoken: getRequestToken() ?? '', Depth: '0', 'Content-Type': 'application/xml' },
			body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:permissions/></d:prop></d:propfind>',
		})
		const text = await response.text()
		const m = text.match(/<oc:permissions>([^<]*)<\/oc:permissions>/)
		return m ? m[1].includes('R') : false
	}

	const ops = {
		async 'share.info'() {
			return { name, signedIn: true, inCloud: true, canShare: await canShare() }
		},

		async 'share.search'({ query }) {
			const data = await ocs('GET', 'sharees', {
				search: query,
				itemType: 'file',
				lookup: 'false',
				perPage: 10,
				shareType: [TYPE.user, TYPE.group, TYPE.email, TYPE.remote, TYPE.team],
			})
			const out = []
			const seen = new Set()
			for (const bucket of [data?.exact ?? {}, data ?? {}]) {
				for (const key of ['users', 'groups', 'emails', 'remotes', 'circles']) {
					for (const e of bucket[key] ?? []) {
						const type = NAME[e.value?.shareType]
						const id = `${type}:${e.value?.shareWith}`
						if (!type || seen.has(id)) {
							continue
						}
						seen.add(id)
						out.push({ label: e.label, detail: e.shareWithDisplayNameUnique || e.subline || null, type, shareWith: e.value.shareWith })
					}
				}
			}
			return out
		},

		'share.list': list,

		async 'share.add'({ type, shareWith, edit, note }) {
			const created = await ocs('POST', 'shares', { path: sharePath, shareType: TYPE[type] ?? TYPE.user, shareWith, permissions: edit ? EDIT : VIEW })
			if (note) {
				// The message travels with the share (in the notification or email).
				await ocs('PUT', `shares/${created.id}`, { note })
			}
			return shareOf(created)
		},

		async 'share.update'({ id, edit, password, expiration }) {
			let s
			if (edit !== undefined) {
				s = await ocs('PUT', `shares/${id}`, { permissions: edit ? EDIT : VIEW })
			}
			if (password !== undefined) {
				s = await ocs('PUT', `shares/${id}`, { password: password ?? '' })
			}
			if (expiration !== undefined) {
				s = await ocs('PUT', `shares/${id}`, { expireDate: expiration ?? '' })
			}
			return s ? shareOf(s) : {}
		},

		async 'share.remove'({ id }) {
			await ocs('DELETE', `shares/${id}`)
			return {}
		},

		async 'share.link'({ edit, password, expiration }) {
			const existing = (await list()).find((s) => s.type === 'link')
			let s
			if (existing) {
				s = await ocs('PUT', `shares/${existing.id}`, { permissions: edit ? EDIT : VIEW })
				if (password) {
					s = await ocs('PUT', `shares/${existing.id}`, { password })
				}
				s = await ocs('PUT', `shares/${existing.id}`, { expireDate: expiration ?? '' })
			} else {
				const params = { path: sharePath, shareType: TYPE.link, permissions: edit ? EDIT : VIEW }
				if (password) {
					params.password = password
				}
				if (expiration) {
					params.expireDate = expiration
				}
				s = await ocs('POST', 'shares', params)
			}
			return shareOf(s)
		},
	}

	return handler(ops)
}

/**
 * The Share dialog for someone who opened a shared link: they can't share the file themselves,
 * only pass the link on.
 * @param {object} o
 * @param {string} o.name the document's name
 * @param {string} o.link the shared link
 */
export function guestSharing({ name, link }) {
	return handler({
		async 'share.info'() {
			return { name, signedIn: true, inCloud: true, canShare: false, link }
		},
	})
}

/** Carries out the dialog's operations with `ops`; each resolves to the reply for WordLogic. */
function handler(ops) {
	return async function handle({ id, op, params }) {
		try {
			const run = ops[op]
			if (!run) {
				throw new Error(`Sharing can't do "${op}" here.`)
			}
			const answer = await run(JSON.parse(params || '{}'))
			return { type: 'wordcraft:cloud:reply', id, ok: true, json: JSON.stringify(answer ?? null) }
		} catch (e) {
			return { type: 'wordcraft:cloud:reply', id, ok: false, error: e.message }
		}
	}
}

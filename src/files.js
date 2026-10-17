// Files app: an "Open in WordLogic" action on documents, the default (click to open) for them.

import { DefaultType, Permission, registerFileAction } from '@nextcloud/files'
import { generateUrl, getRootUrl } from '@nextcloud/router'
import { getSharingToken, isPublicShare } from '@nextcloud/sharing/public'

/** Word and OpenDocument documents, and RTF: WordLogic saves them back as they are. */
const DOCUMENTS = ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf']
/** Word 97–2003: opened, and saved as `<name>.docx` next to the original. */
const IMPORTS = ['doc', 'dot']
/**
 * Plain text and Markdown: WordLogic opens and saves them too, but Nextcloud's Text app stays
 * their default; WordLogic is in the file's menu.
 */
const TEXT = ['txt', 'md', 'markdown']

// WordLogic's "W trace" as a monochrome glyph: a page with a header band and the W.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2H5z"/><polyline points="8,10.5 10,17 12,12.5 14,17 16,10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function extension(node) {
	const name = node.basename ?? ''
	const i = name.lastIndexOf('.')
	return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Whether `node` is a file WordLogic opens, of one of `kinds`, that the user can read. */
function opens(node, kinds = [DOCUMENTS, IMPORTS, TEXT]) {
	const ext = extension(node)
	return node.type === 'file' && kinds.some((k) => k.includes(ext)) && (node.permissions & Permission.READ) !== 0
}

function open(node) {
	// On a link to a folder, through the link: the path is within the shared folder.
	const token = isPublicShare() ? getSharingToken() : null
	const url = new URL(generateUrl(token ? `/apps/wordcraft/s/${encodeURIComponent(token)}/edit` : '/apps/wordcraft/edit'), location.href)
	url.searchParams.set('path', node.path)
	window.location.assign(url.toString())
}

registerFileAction({
	id: 'wordcraft-open',
	displayName: () => 'Open in WordLogic',
	iconSvgInline: () => ICON,
	enabled: ({ nodes }) => nodes.length === 1 && opens(nodes[0], [DOCUMENTS, IMPORTS]),
	async exec({ nodes }) {
		open(nodes[0])
		return null
	},
	order: -10,
	default: DefaultType.DEFAULT,
})

// The same for text and Markdown files, without taking the click from the Text app.
registerFileAction({
	id: 'wordcraft-open-text',
	displayName: () => 'Open in WordLogic',
	iconSvgInline: () => ICON,
	enabled: ({ nodes }) => nodes.length === 1 && opens(nodes[0], [TEXT]),
	async exec({ nodes }) {
		open(nodes[0])
		return null
	},
	order: -10,
})

// "Open in WordLogic desktop app": the file in WordLogic on this computer (`wordlogic://open`,
// as in `editor.js`), signed in to this Nextcloud and co-editing with the browser.
registerFileAction({
	id: 'wordcraft-open-desktop',
	displayName: () => 'Open in WordLogic desktop app',
	iconSvgInline: () => ICON,
	enabled: ({ nodes }) => nodes.length === 1 && opens(nodes[0]) && !isPublicShare(),
	async exec({ nodes }) {
		const server = `${location.origin}${getRootUrl()}`
		location.href = `wordlogic://open?server=${encodeURIComponent(server)}&path=${encodeURIComponent(nodes[0].path)}`
		return null
	},
	order: -9,
})

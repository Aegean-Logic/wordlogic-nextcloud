// Files app: an "Open in WordLogic" action on documents, the default (click to open) for them.

import { DefaultType, Permission, registerFileAction } from '@nextcloud/files'
import { generateUrl } from '@nextcloud/router'

/** Word and OpenDocument documents, and RTF: WordLogic saves them back as they are. */
const DOCUMENTS = ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf']
/** Word 97–2003: opened, and saved as `<name>.docx` next to the original. */
const IMPORTS = ['doc', 'dot']
/**
 * Plain text and Markdown: WordLogic opens and saves them too, but Nextcloud's Text app stays
 * their default; WordLogic is in the file's menu.
 */
const TEXT = ['txt', 'md', 'markdown']

// Original icon: a page with a folded corner and three lines of text.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M5 2h9l5 5v15H5V2zm2 2v16h10V8h-4V4H7zm2 7h6v1.5H9V11zm0 3h6v1.5H9V14zm0 3h4v1.5H9V17z"/></svg>'

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
	const url = new URL(generateUrl('/apps/wordcraft/edit'), location.href)
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

<?php

declare(strict_types=1);

namespace OCA\WordCraft\Service;

use OCP\Files\IAppData;
use OCP\Files\NotFoundException;
use OCP\Files\SimpleFS\ISimpleFile;
use OCP\Files\SimpleFS\ISimpleFolder;

/**
 * The state snapshots kept with co-editing checkpoints, as app data: `collab/<session id>/<log
 * position>.json`, the latest checkpoint's only. Each is WordLogic's own text for the shared
 * document (JSON with pictures inside); the server never reads it.
 */
class SnapshotStore {
	private const ROOT = 'collab';

	public function __construct(
		private IAppData $appData,
	) {
	}

	public function put(int $sessionId, int $seq, string $state): void {
		$folder = $this->folder($sessionId, true);
		$name = self::name($seq);
		if ($folder->fileExists($name)) {
			$folder->getFile($name)->putContent($state);
		} else {
			$folder->newFile($name, $state);
		}
	}

	public function get(int $sessionId, int $seq): ?ISimpleFile {
		$folder = $this->folder($sessionId, false);
		try {
			return $folder?->getFile(self::name($seq));
		} catch (NotFoundException) {
			return null;
		}
	}

	public function has(int $sessionId, int $seq): bool {
		return $this->folder($sessionId, false)?->fileExists(self::name($seq)) ?? false;
	}

	/** Deletes the session's snapshots other than the one for `$seq`. */
	public function keepOnly(int $sessionId, int $seq): void {
		$folder = $this->folder($sessionId, false);
		if ($folder === null) {
			return;
		}
		$keep = self::name($seq);
		foreach ($folder->getDirectoryListing() as $file) {
			if ($file->getName() !== $keep) {
				$file->delete();
			}
		}
	}

	/** Deletes all of the session's snapshots. */
	public function clear(int $sessionId): void {
		$this->folder($sessionId, false)?->delete();
	}

	private function folder(int $sessionId, bool $create): ?ISimpleFolder {
		try {
			$root = $this->appData->getFolder(self::ROOT);
		} catch (NotFoundException) {
			if (!$create) {
				return null;
			}
			$root = $this->appData->newFolder(self::ROOT);
		}
		try {
			return $root->getFolder((string)$sessionId);
		} catch (NotFoundException) {
			return $create ? $root->newFolder((string)$sessionId) : null;
		}
	}

	private static function name(int $seq): string {
		return $seq . '.json';
	}
}

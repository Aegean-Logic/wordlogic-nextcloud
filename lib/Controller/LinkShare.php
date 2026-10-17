<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\Share\EditorPageProvider;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\InvalidPathException;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\Share\Exceptions\ShareNotFound;
use OCP\Share\IShare;

/**
 * What the controllers behind a shared link (`/s/{token}`) have in common: the link itself (a
 * link or email share), its password (Nextcloud's public share checks use these), and the
 * document it gives: the shared file, or one inside the shared folder.
 *
 * Needs `$this->shareManager` (`OCP\Share\IManager`).
 */
trait LinkShare {
	private ?IShare $share = null;

	protected function getPasswordHash(): ?string {
		return $this->share?->getPassword();
	}

	public function isValidToken(): bool {
		try {
			$share = $this->shareManager->getShareByToken($this->getToken());
		} catch (ShareNotFound) {
			return false;
		}
		if (!in_array($share->getShareType(), [IShare::TYPE_LINK, IShare::TYPE_EMAIL], true)) {
			return false;
		}
		$this->share = $share;
		return true;
	}

	protected function isPasswordProtected(): bool {
		return $this->share?->getPassword() !== null;
	}

	/**
	 * The document at `$path` in the shared folder; the shared file itself when the link is
	 * to a file (`$path` empty).
	 */
	private function sharedFile(string $path = ''): File {
		try {
			$node = $this->share?->getNode();
			if ($node instanceof Folder) {
				$node = trim($path, '/') === '' ? null : $node->get(trim($path, '/'));
			} elseif (trim($path, '/') !== '') {
				$node = null;
			}
		} catch (NotFoundException|NotPermittedException|InvalidPathException) {
			// Not there, or a path out of the shared folder (`..`).
			$node = null;
		}
		if (!$node instanceof File
			|| ($this->share->getPermissions() & Constants::PERMISSION_READ) === 0
			|| !in_array(strtolower(pathinfo($node->getName(), PATHINFO_EXTENSION)), EditorPageProvider::EXTENSIONS, true)) {
			throw new NotAllowed('The file is not available.');
		}
		return $node;
	}

	/** The file with id `$fileId` within the link: the shared file, or one inside the shared folder. */
	private function sharedFileById(int $fileId): File {
		try {
			$node = $this->share?->getNode();
			if ($node instanceof Folder) {
				$node = $node->getFirstNodeById($fileId);
			} elseif ($node !== null && $node->getId() !== $fileId) {
				$node = null;
			}
		} catch (NotFoundException) {
			$node = null;
		}
		if (!$node instanceof File || ($this->share->getPermissions() & Constants::PERMISSION_READ) === 0) {
			throw new NotAllowed('The file is not available.');
		}
		return $node;
	}

	/** Whether the link allows editing (and the file still can be). */
	private function linkCanEdit(File $file): bool {
		return ($this->share->getPermissions() & Constants::PERMISSION_UPDATE) !== 0 && $file->isUpdateable();
	}
}

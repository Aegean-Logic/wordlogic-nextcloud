<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Service\CollabService;
use OCA\WordCraft\Service\NotMemberException;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Response;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * Co-editing endpoints for the editor page. Every call checks the user can still read the file
 * (and, to push edits or record a save, write it).
 */
class CollabController extends Controller {
	use CollabResponses;

	public function __construct(
		IRequest $request,
		private CollabService $collab,
		private IUserSession $userSession,
		private IRootFolder $rootFolder,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'POST', url: '/collab/join')]
	public function join(int $fileId, string $etag): Response {
		return $this->guard(function () use ($fileId, $etag) {
			$user = $this->userSession->getUser();
			$node = $this->file($fileId);
			$canEdit = $node->isUpdateable();
			$result = $this->collab->join($fileId, $etag, $user->getUID(), $user->getDisplayName(), $canEdit);
			$result['canEdit'] = $canEdit;
			return $result;
		});
	}

	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'POST', url: '/collab/push')]
	public function push(int $sessionId, int $client, int $clientSeq, int $base, string $op): Response {
		return $this->guard(function () use ($sessionId, $client, $clientSeq, $base, $op) {
			$node = $this->sessionFile($sessionId);
			if (!$node->isUpdateable()) {
				return self::viewOnly();
			}
			return ['seq' => $this->collab->push($sessionId, $client, $this->uid(), $clientSeq, $base, $op)];
		});
	}

	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'GET', url: '/collab/sync')]
	public function sync(int $sessionId, int $client, int $since, string $sel = ''): Response {
		return $this->guard(function () use ($sessionId, $client, $since, $sel) {
			$this->sessionFile($sessionId);
			return $this->collab->sync($sessionId, $client, $this->uid(), $since, $sel);
		});
	}

	/**
	 * The file was saved for the session at `$seq` (with `$etag`); `$state` is WordLogic's
	 * snapshot of the shared document there, for people who join later (up to
	 * `CollabService::MAX_STATE_BYTES`, so the request can be tens of MB).
	 */
	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'POST', url: '/collab/checkpoint')]
	public function checkpoint(int $sessionId, int $client, int $seq, string $etag, string $state = ''): Response {
		return $this->guard(function () use ($sessionId, $client, $seq, $etag, $state) {
			$node = $this->sessionFile($sessionId);
			if (!$node->isUpdateable()) {
				return self::viewOnly();
			}
			self::requireSaved($node, $etag);
			$this->collab->checkpoint($sessionId, $client, $this->uid(), $seq, $etag, $state);
			return [];
		});
	}

	/** The state snapshot of the checkpoint at `$seq`, for a member who joined there (`hasState`). */
	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'GET', url: '/collab/state')]
	public function state(int $sessionId, int $client, int $seq): Response {
		return $this->guard(function () use ($sessionId, $client, $seq) {
			$this->sessionFile($sessionId);
			return self::snapshot($this->collab->state($sessionId, $client, $this->uid(), $seq));
		});
	}

	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'POST', url: '/collab/leave')]
	public function leave(int $sessionId, int $client): Response {
		return $this->guard(function () use ($sessionId, $client) {
			$this->collab->leave($sessionId, $client, $this->uid());
			return [];
		});
	}

	private function uid(): string {
		return $this->userSession->getUser()?->getUID() ?? throw new NotAllowed('Sign in to edit.');
	}

	/** The file `$fileId` as the signed-in user sees it. */
	private function file(int $fileId): File {
		$node = $this->rootFolder->getUserFolder($this->uid())->getFirstNodeById($fileId);
		if (!$node instanceof File || !$node->isReadable()) {
			throw new NotAllowed('The file is not available.');
		}
		return $node;
	}

	private function sessionFile(int $sessionId): File {
		$fileId = $this->collab->fileOf($sessionId) ?? throw new NotMemberException();
		return $this->file($fileId);
	}
}

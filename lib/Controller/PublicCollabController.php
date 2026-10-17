<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Service\CollabService;
use OCA\WordCraft\Service\NotMemberException;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\PublicShareController;
use OCP\Files\File;
use OCP\IRequest;
use OCP\ISession;
use OCP\Security\ISecureRandom;
use OCP\Share\IManager as ShareManager;

/**
 * Co-editing for people who open a shared link (`/s/{token}`), to a document or to a folder
 * with documents: the same sequencer as signed-in users, reached through the link. Nextcloud's public share checks run first (the link exists,
 * link sharing is on, and a password-protected link was unlocked in this browser session).
 *
 * Link visitors have no account: joining hands out a random key, and each later call proves
 * membership with it. Edits (and recording saves) need the link to allow editing.
 */
class PublicCollabController extends PublicShareController {
	use CollabResponses;
	use LinkShare;

	/** A visitor's name as shown to the others. */
	private const MAX_NAME = 64;

	public function __construct(
		IRequest $request,
		ISession $session,
		private ShareManager $shareManager,
		private CollabService $collab,
		private ISecureRandom $random,
	) {
		parent::__construct(Application::APP_ID, $request, $session);
	}

	#[PublicPage]
	#[FrontpageRoute(verb: 'POST', url: '/s/{token}/collab/join')]
	public function join(string $etag, string $displayName = '', string $path = ''): Response {
		return $this->guard(function () use ($etag, $displayName, $path) {
			// `$path`: the document within a shared folder (none for a link to a file).
			$file = $this->sharedFile($path);
			$canEdit = $this->linkCanEdit($file);
			$key = $this->random->generate(32, ISecureRandom::CHAR_ALPHANUMERIC);
			$result = $this->collab->join($file->getId(), $etag, self::visitor($key), self::name($displayName), $canEdit);
			if (!isset($result['retry'])) {
				$result['key'] = $key;
				$result['canEdit'] = $canEdit;
			}
			return $result;
		});
	}

	#[PublicPage]
	#[FrontpageRoute(verb: 'POST', url: '/s/{token}/collab/push')]
	public function push(int $sessionId, int $client, string $key, int $clientSeq, int $base, string $op): Response {
		return $this->guard(function () use ($sessionId, $client, $key, $clientSeq, $base, $op) {
			$file = $this->sessionFile($sessionId);
			if (!$this->linkCanEdit($file)) {
				return self::viewOnly();
			}
			return ['seq' => $this->collab->push($sessionId, $client, self::visitor($key), $clientSeq, $base, $op)];
		});
	}

	#[PublicPage]
	#[FrontpageRoute(verb: 'GET', url: '/s/{token}/collab/sync')]
	public function sync(int $sessionId, int $client, string $key, int $since, string $sel = ''): Response {
		return $this->guard(function () use ($sessionId, $client, $key, $since, $sel) {
			$this->sessionFile($sessionId);
			return $this->collab->sync($sessionId, $client, self::visitor($key), $since, $sel);
		});
	}

	#[PublicPage]
	#[FrontpageRoute(verb: 'POST', url: '/s/{token}/collab/checkpoint')]
	public function checkpoint(int $sessionId, int $client, string $key, int $seq, string $etag, string $state = ''): Response {
		return $this->guard(function () use ($sessionId, $client, $key, $seq, $etag, $state) {
			$file = $this->sessionFile($sessionId);
			if (!$this->linkCanEdit($file)) {
				return self::viewOnly();
			}
			self::requireSaved($file, $etag);
			$this->collab->checkpoint($sessionId, $client, self::visitor($key), $seq, $etag, $state);
			return [];
		});
	}

	/** The state snapshot of the checkpoint at `$seq`, for a member who joined there. */
	#[PublicPage]
	#[FrontpageRoute(verb: 'GET', url: '/s/{token}/collab/state')]
	public function state(int $sessionId, int $client, string $key, int $seq): Response {
		return $this->guard(function () use ($sessionId, $client, $key, $seq) {
			$this->sessionFile($sessionId);
			return self::snapshot($this->collab->state($sessionId, $client, self::visitor($key), $seq));
		});
	}

	#[PublicPage]
	#[FrontpageRoute(verb: 'POST', url: '/s/{token}/collab/leave')]
	public function leave(int $sessionId, int $client, string $key): Response {
		return $this->guard(function () use ($sessionId, $client, $key) {
			$this->collab->leave($sessionId, $client, self::visitor($key));
			return [];
		});
	}

	/** The session's file, within the link. */
	private function sessionFile(int $sessionId): File {
		$fileId = $this->collab->fileOf($sessionId) ?? throw new NotMemberException();
		return $this->sharedFileById($fileId);
	}

	/** The member id for a visitor's key: the key itself is never stored. */
	private static function visitor(string $key): string {
		if (strlen($key) < 32) {
			throw new NotMemberException();
		}
		return 'link:' . substr(hash('sha256', $key), 0, 40);
	}

	private static function name(string $name): string {
		$name = trim((string)preg_replace('/\p{C}+/u', '', $name));
		return $name === '' ? 'Guest' : mb_substr($name, 0, self::MAX_NAME);
	}
}

<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Service\MentionService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;

/**
 * @mentions: the editor (browser or desktop) asks for the people mentioned in a comment to be
 * told; the chat beside the editor (talk.js), for people its message brought into the file's chat,
 * and for the people in the chat when a call about the file starts.
 */
class MentionController extends Controller {
	use CollabResponses;

	public function __construct(
		IRequest $request,
		private MentionService $mentions,
		private IUserSession $userSession,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * @param list<mixed> $people Nextcloud user ids
	 * @param string $where `comment` (a comment in the file), `chat` (the file's chat) or `call`
	 *                      (a call about the file started: the people in its chat are told)
	 * @return DataResponse `{notified: [id], noAccess: [{id, name}]}`
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 60, period: 3600)]
	#[FrontpageRoute(verb: 'POST', url: '/mention')]
	public function notify(int $fileId, array $people = [], string $text = '', string $anchor = '', string $where = MentionService::IN_COMMENT): DataResponse {
		return $this->guard(function () use ($fileId, $people, $text, $anchor, $where) {
			$user = $this->userSession->getUser() ?? throw new NotAllowed('Sign in to mention people.');
			return $this->mentions->notify($user, $fileId, array_values($people), $text, $anchor, $where);
		});
	}
}

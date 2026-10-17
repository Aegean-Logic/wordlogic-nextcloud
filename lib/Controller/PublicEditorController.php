<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Share\EditorPageProvider;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\PublicShareController;
use OCP\Files\NotFoundException;
use OCP\IRequest;
use OCP\ISession;
use OCP\Share\IManager as ShareManager;

/**
 * A document inside a shared folder (`/s/{token}`), opened in WordLogic from the folder's page:
 * `/apps/wordcraft/s/{token}/edit?path=/Reports/Report.docx`. Nextcloud's public share checks run
 * first: the link exists, and a password-protected link was unlocked on its own page in this
 * browser session.
 */
class PublicEditorController extends PublicShareController {
	use LinkShare;

	public function __construct(
		IRequest $request,
		ISession $session,
		private ShareManager $shareManager,
		private EditorPageProvider $pages,
	) {
		parent::__construct(Application::APP_ID, $request, $session);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	#[FrontpageRoute(verb: 'GET', url: '/s/{token}/edit')]
	public function edit(string $path = ''): TemplateResponse {
		try {
			$file = $this->sharedFile($path);
		} catch (NotAllowed) {
			throw new NotFoundException('This file is not in the shared folder, or not a document.');
		}
		$share = $this->share ?? throw new NotFoundException();
		return $this->pages->page($share, $this->getToken(), $file, '/' . trim($path, '/'));
	}
}

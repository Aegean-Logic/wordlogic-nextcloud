<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\App\IAppManager;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\Util;

class EditorController extends Controller {
	public function __construct(
		IRequest $request,
		private IURLGenerator $urlGenerator,
		private IAppManager $appManager,
		private IRootFolder $rootFolder,
		private IUserSession $userSession,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * The editor page: WordLogic in an iframe on this origin. The page's script reads and
	 * writes the file over WebDAV with the user's session; `path` is relative to their files.
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[FrontpageRoute(verb: 'GET', url: '/edit')]
	public function edit(string $path = ''): TemplateResponse {
		Util::addScript(Application::APP_ID, 'wordcraft-editor');
		Util::addStyle(Application::APP_ID, 'editor');
		$response = new TemplateResponse(Application::APP_ID, 'editor', [
			'path' => $path,
			// For co-editing: sessions are per file, and a file keeps its id when renamed or moved.
			'fileId' => $this->fileId($path),
			// The version in the URL makes browsers fetch the new page after an upgrade: a cached
			// old one names wasm and script files the upgrade replaced, and wouldn't start.
			'editorUrl' => $this->urlGenerator->linkTo(Application::APP_ID, 'editor/index.html')
				. '?v=' . rawurlencode($this->appManager->getAppVersion(Application::APP_ID)),
			// Until the WordLogic web build is vendored into editor/ (editor/README.md).
			'editorMissing' => !Application::editorInstalled($this->appManager),
		]);
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedFrameDomain("'self'");
		$response->setContentSecurityPolicy($csp);
		return $response;
	}

	/** The id of the signed-in user's file at `$path`, or 0. */
	private function fileId(string $path): int {
		$user = $this->userSession->getUser();
		if ($user === null || $path === '') {
			return 0;
		}
		try {
			return $this->rootFolder->getUserFolder($user->getUID())->get($path)->getId() ?? 0;
		} catch (NotFoundException) {
			return 0;
		}
	}
}

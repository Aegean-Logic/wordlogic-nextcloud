<?php

declare(strict_types=1);

namespace OCA\WordCraft\Share;

use OCA\WordCraft\AppInfo\Application;
use OCP\Accounts\IAccountManager;
use OCP\App\IAppManager;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\Template\PublicTemplateResponse;
use OCP\AppFramework\Http\Template\SimpleMenuAction;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\IUserManager;
use OCP\Share\IPublicShareTemplateProvider;
use OCP\Share\IShare;
use OCP\Util;

/**
 * A shared link to a document (`/s/{token}`) opens in WordLogic, as a link to a document in
 * OneDrive opens in Word for the web: view-only links to view, edit links to edit together with
 * everyone else who has it open (signed-in users included). The page loads and saves the file
 * through the link's own WebDAV address; Nextcloud has checked the link (and its password) first.
 *
 * Text and Markdown links keep Nextcloud's own page (the Text app's), as their click in Files does.
 */
class EditorPageProvider implements IPublicShareTemplateProvider {
	/** What WordLogic opens: the extensions of the Files actions (`src/files.js`). */
	public const EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'doc', 'dot', 'txt', 'md', 'markdown'];
	/** What a link opens in WordLogic: the documents it's the default for (no text or Markdown). */
	public const LINK_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf', 'doc', 'dot'];

	public function __construct(
		private IURLGenerator $urlGenerator,
		private IAppManager $appManager,
		private IUserManager $userManager,
		private IAccountManager $accountManager,
	) {
	}

	public function shouldRespond(IShare $share): bool {
		try {
			$node = $share->getNode();
		} catch (NotFoundException) {
			return false;
		}
		return $node instanceof File
			&& ($share->getPermissions() & Constants::PERMISSION_READ) !== 0
			&& in_array(strtolower(pathinfo($node->getName(), PATHINFO_EXTENSION)), self::LINK_EXTENSIONS, true);
	}

	public function renderPage(IShare $share, string $token, string $path): TemplateResponse {
		$file = $share->getNode();
		if (!$file instanceof File) {
			throw new NotFoundException();
		}
		return $this->page($share, $token, $file, '');
	}

	/**
	 * WordLogic for `$file` through the link `$token`: the shared file (`$path` empty), or the
	 * document at `$path` in the shared folder (`Controller\PublicEditorController`).
	 */
	public function page(IShare $share, string $token, File $file, string $path): TemplateResponse {
		$canEdit = ($share->getPermissions() & Constants::PERMISSION_UPDATE) !== 0 && $file->isUpdateable();
		Util::addScript(Application::APP_ID, 'wordcraft-editor');
		Util::addStyle(Application::APP_ID, 'editor');
		$response = new PublicTemplateResponse(Application::APP_ID, 'editor', [
			'path' => '',
			'fileId' => $file->getId(),
			'shareToken' => $token,
			'sharePath' => $path,
			'fileName' => $file->getName(),
			'canEdit' => $canEdit,
			'editorUrl' => $this->urlGenerator->linkTo(Application::APP_ID, 'editor/index.html')
				. '?v=' . rawurlencode($this->appManager->getAppVersion(Application::APP_ID)),
			'editorMissing' => !Application::editorInstalled($this->appManager),
		]);
		$response->setHeaderTitle($path === '' && $share->getLabel() !== '' ? $share->getLabel() : $file->getName());
		$owner = $this->publicOwnerName($share);
		if ($owner !== '') {
			$response->setHeaderDetails('shared by ' . $owner);
		}
		if ($share->canDownload() && !$share->getHideDownload()) {
			$segments = array_map('rawurlencode', array_values(array_filter(explode('/', $path), fn ($s) => $s !== '')));
			$download = $this->urlGenerator->getAbsoluteURL('/public.php/dav/files/' . rawurlencode($token) . ($segments === [] ? '' : '/' . implode('/', $segments)));
			$response->setHeaderActions([new SimpleMenuAction('download', 'Download', 'icon-download', $download, 0, (string)$file->getSize())]);
		}
		$response->setFooterVisible(false);
		$csp = new ContentSecurityPolicy();
		$csp->addAllowedFrameDomain("'self'");
		$response->setContentSecurityPolicy($csp);
		return $response;
	}

	/** The owner's name, if they chose to make it public. */
	private function publicOwnerName(IShare $share): string {
		$owner = $this->userManager->get($share->getShareOwner());
		if (!$owner instanceof IUser) {
			return '';
		}
		$name = $this->accountManager->getAccount($owner)->getProperty(IAccountManager::PROPERTY_DISPLAYNAME);
		return $name->getScope() === IAccountManager::SCOPE_PUBLISHED ? $owner->getDisplayName() : '';
	}
}

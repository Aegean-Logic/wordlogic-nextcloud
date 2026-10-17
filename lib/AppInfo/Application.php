<?php

declare(strict_types=1);

namespace OCA\WordCraft\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\WordCraft\Listener\LoadFilesScripts;
use OCP\App\IAppManager;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
	public const APP_ID = 'wordcraft';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// The Files app loads our "Open in WordLogic" action.
		$context->registerEventListener(LoadAdditionalScriptsEvent::class, LoadFilesScripts::class);
	}

	public function boot(IBootContext $context): void {
	}

	/** Whether the WordLogic web build is in `editor/` (it's vendored separately: editor/README.md). */
	public static function editorInstalled(IAppManager $appManager): bool {
		return is_file($appManager->getAppPath(self::APP_ID) . '/editor/index.html');
	}
}

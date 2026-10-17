<?php

declare(strict_types=1);

namespace OCA\WordCraft\BackgroundJob;

use OCA\WordCraft\Service\CollabService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJob;
use OCP\BackgroundJob\TimedJob;

/** Removes co-editing sessions nobody uses any more, and their snapshots (`CollabService::cleanUp`). */
class CleanUpSessions extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private CollabService $collab,
	) {
		parent::__construct($time);
		$this->setInterval(3600);
		$this->setTimeSensitivity(IJob::TIME_INSENSITIVE);
	}

	protected function run($argument): void {
		$this->collab->cleanUp();
	}
}

<?php

declare(strict_types=1);

namespace OCA\WordCraft\Service;

/**
 * The client isn't (or is no longer) in the session: it has to join again. `outdated`: it is in
 * the session, but on an older build than the newest that joined, so it reads the edits
 * differently; joining again helps only with a newer build (a page reload brings one).
 */
class NotMemberException extends \RuntimeException {
	public function __construct(
		public readonly bool $outdated = false,
	) {
		parent::__construct($outdated ? 'outdated build' : 'not a member');
	}
}

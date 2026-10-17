<?php

declare(strict_types=1);

namespace OCA\WordCraft\Service;

/** No state snapshot is kept for that checkpoint (a later one replaced it): join again. */
class StateGoneException extends \RuntimeException {
}

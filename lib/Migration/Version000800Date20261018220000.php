<?php

declare(strict_types=1);

namespace OCA\WordCraft\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Co-editing: which co-editing protocol each member's WordLogic runs, and the newest one in each
 * session (`CollabService::requireMember`): a member on an older one rejoins with the new one
 * rather than misread edits it doesn't know.
 */
class Version000800Date20261018220000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$changed = false;
		foreach (['wordcraft_sessions', 'wordcraft_members'] as $name) {
			if (!$schema->hasTable($name)) {
				continue;
			}
			$t = $schema->getTable($name);
			if (!$t->hasColumn('build')) {
				// Nullable: Nextcloud refuses a NOT NULL string column with an empty default.
				$t->addColumn('build', Types::STRING, ['notnull' => false, 'length' => 32]);
				$changed = true;
			}
		}
		return $changed ? $schema : null;
	}
}

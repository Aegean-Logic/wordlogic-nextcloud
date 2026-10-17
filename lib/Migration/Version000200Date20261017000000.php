<?php

declare(strict_types=1);

namespace OCA\WordCraft\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Co-editing: one session per shared file, its op log, and who's in it (with where they are in
 * the document and whether they can edit). Checkpoint state snapshots live in app data, not here.
 */
class Version000200Date20261017000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('wordcraft_sessions')) {
			$t = $schema->createTable('wordcraft_sessions');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('file_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			// The last log position handed out.
			$t->addColumn('last_seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			// The file as last saved for the session: its log position and ETag.
			$t->addColumn('checkpoint_seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			$t->addColumn('checkpoint_etag', Types::STRING, ['notnull' => true, 'default' => '', 'length' => 64]);
			$t->addColumn('next_client', Types::BIGINT, ['notnull' => true, 'default' => 1, 'unsigned' => true]);
			// When someone last joined, edited or saved (idle sessions are cleaned up).
			$t->addColumn('last_active', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['file_id'], 'wc_sessions_file');
		}

		if (!$schema->hasTable('wordcraft_ops')) {
			$t = $schema->createTable('wordcraft_ops');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('session_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('seq', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('client', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('client_seq', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('base', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			// The op as JSON text, passed through untouched.
			$t->addColumn('op', Types::TEXT, ['notnull' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['session_id', 'seq'], 'wc_ops_seq');
			// A retried push is recognised, not logged twice.
			$t->addUniqueIndex(['session_id', 'client', 'client_seq'], 'wc_ops_client');
		}

		if (!$schema->hasTable('wordcraft_members')) {
			$t = $schema->createTable('wordcraft_members');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('session_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('client', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('display_name', Types::STRING, ['notnull' => true, 'default' => '', 'length' => 255]);
			$t->addColumn('last_seen', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			// Where they are (WordLogic's caret and selection, JSON the server doesn't read).
			$t->addColumn('selection', Types::TEXT, ['notnull' => false]);
			// Whether they can edit: only editors save the shared document to the file.
			$t->addColumn('can_edit', Types::SMALLINT, ['notnull' => true, 'default' => 1, 'unsigned' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['session_id', 'client'], 'wc_members_client');
		}
		return $schema;
	}
}

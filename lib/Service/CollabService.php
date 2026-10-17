<?php

declare(strict_types=1);

namespace OCA\WordCraft\Service;

use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\Exception as DbException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Files\SimpleFS\ISimpleFile;
use OCP\IDBConnection;

/**
 * The co-editing sequencer: one session per file, an op log with gap-free positions, and who's
 * in it. It never looks inside ops (WordLogic in each browser does all the merging); it only
 * orders them, keeps them until the file is saved past them, and says where to start from.
 *
 * Each checkpoint (the file saved for the session) can carry a state snapshot: the shared
 * document exactly as of the checkpoint's log position, as WordLogic hands it over (opaque text).
 * Reading the saved file back doesn't reproduce the document's internal ids, so people joining
 * start from the snapshot. Snapshots are kept as app data (`SnapshotStore`), the latest only.
 */
class CollabService {
	/** A member not heard from for this long no longer counts as in the session. */
	public const ACTIVE_SECONDS = 60;
	/** The largest op accepted (JSON text). */
	public const MAX_OP_BYTES = 16 * 1024 * 1024;
	/** The most log entries per sync. */
	public const MAX_BATCH = 500;
	/** The largest position (caret and selection) kept per member. */
	public const MAX_SELECTION_BYTES = 8192;
	/** Log entries kept before the last checkpoint, for members still catching up. */
	public const KEEP_BEFORE_CHECKPOINT = 1000;
	/** The largest state snapshot kept with a checkpoint (pictures travel inside it). */
	public const MAX_STATE_BYTES = 32 * 1024 * 1024;
	/** A session nobody has used for this long is removed if everything in it was saved… */
	public const IDLE_SECONDS = 86400;
	/** …and after this long even if it wasn't (its last edits never reached the file). */
	public const ABANDONED_SECONDS = 30 * 86400;
	/** Client ids stay below 2^32: WordLogic namespaces the ids of new objects by client. */
	private const MAX_CLIENT = 4294967295;

	public function __construct(
		private IDBConnection $db,
		private ITimeFactory $time,
		private SnapshotStore $snapshots,
	) {
	}

	/**
	 * Joins the session for a file, starting one if there's none. `$etag` is the file's ETag as
	 * the joiner loaded it. Returns `['retry' => true]` if the file was saved for the session
	 * after that (load it again), otherwise the session, the joiner's client id, the log
	 * position the loaded file is at, whether a state snapshot is kept for that position
	 * (`hasState`: fetch it with `state()`), and the log entries after it.
	 */
	public function join(int $fileId, string $etag, string $userId, string $displayName, bool $canEdit = true): array {
		$etag = self::bareEtag($etag);
		for ($attempt = 0; ; $attempt++) {
			$this->db->beginTransaction();
			try {
				$result = $this->joinLocked($fileId, $etag, $userId, $displayName, $canEdit);
				if (isset($result['retry'])) {
					$this->db->rollBack();
					return $result;
				}
				$this->db->commit();
				break;
			} catch (DbException $e) {
				$this->db->rollBack();
				// Two people starting the session at once: the second joins the first's.
				if ($attempt === 0 && $e->getReason() === DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
					continue;
				}
				throw $e;
			}
		}
		$restarted = $result['restarted'];
		unset($result['restarted']);
		if ($restarted) {
			// The log starts again from the file: earlier snapshots don't describe it.
			$this->snapshots->clear($result['sessionId']);
		}
		$result['hasState'] = $result['seq'] > 0 && $this->snapshots->has($result['sessionId'], $result['seq']);
		return $result;
	}

	private function joinLocked(int $fileId, string $etag, string $userId, string $displayName, bool $canEdit): array {
		$now = $this->time->getTime();
		// Taking a client id locks the session row for the rest of the transaction.
		$qb = $this->db->getQueryBuilder();
		$taken = $qb->update('wordcraft_sessions')
			->set('next_client', $qb->createFunction('next_client + 1'))
			->set('last_active', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->executeStatement();
		if ($taken === 0) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('wordcraft_sessions')->values([
				'file_id' => $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT),
				'last_seq' => $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
				'checkpoint_seq' => $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
				'checkpoint_etag' => $qb->createNamedParameter($etag),
				'next_client' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'last_active' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}
		$session = $this->sessionByFile($fileId);
		if ($session === null) {
			throw new \RuntimeException('co-editing session vanished');
		}
		$id = (int)$session['id'];
		$client = (int)$session['next_client'] - 1;
		if ($client > self::MAX_CLIENT) {
			throw new \RuntimeException('co-editing: out of client ids for this file');
		}

		$restarted = false;
		if ($session['checkpoint_etag'] !== $etag) {
			if ($this->activeMembers($id, $now) !== []) {
				// Saved for the session since the joiner loaded it: load it again.
				return ['retry' => true];
			}
			// Nobody's here and the file changed (outside the session, or a session long gone):
			// the file as it is now is where the log starts.
			$qb = $this->db->getQueryBuilder();
			$qb->delete('wordcraft_ops')->where($qb->expr()->eq('session_id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();
			$qb = $this->db->getQueryBuilder();
			$qb->delete('wordcraft_members')->where($qb->expr()->eq('session_id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();
			$qb = $this->db->getQueryBuilder();
			$qb->update('wordcraft_sessions')
				->set('checkpoint_seq', 'last_seq')
				->set('checkpoint_etag', $qb->createNamedParameter($etag))
				->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
				->executeStatement();
			$session = $this->sessionByFile($fileId) ?? $session;
			$restarted = true;
		}

		$qb = $this->db->getQueryBuilder();
		$qb->insert('wordcraft_members')->values([
			'session_id' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
			'client' => $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT),
			'user_id' => $qb->createNamedParameter($userId),
			'display_name' => $qb->createNamedParameter(mb_substr($displayName, 0, 255)),
			'last_seen' => $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			'can_edit' => $qb->createNamedParameter($canEdit ? 1 : 0, IQueryBuilder::PARAM_INT),
		])->executeStatement();

		$from = (int)$session['checkpoint_seq'];
		return [
			'sessionId' => $id,
			'client' => $client,
			'seq' => $from,
			'entries' => $this->entries($id, $from, PHP_INT_MAX),
			'members' => $this->activeMembers($id, $now),
			'restarted' => $restarted,
		];
	}

	/**
	 * Appends an op to the log and returns its position. A retried push (the same client and
	 * client sequence number) gets the position it was given the first time.
	 */
	public function push(int $sessionId, int $client, string $userId, int $clientSeq, int $base, string $op): int {
		$this->requireMember($sessionId, $client, $userId);
		if (strlen($op) > self::MAX_OP_BYTES) {
			throw new \InvalidArgumentException('the edit is too large to share');
		}
		$decoded = json_decode($op);
		if (!is_object($decoded)) {
			throw new \InvalidArgumentException('the edit is not a JSON object');
		}
		$existing = $this->opSeq($sessionId, $client, $clientSeq);
		if ($existing !== null) {
			return $existing;
		}
		$this->db->beginTransaction();
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->update('wordcraft_sessions')
				->set('last_seq', $qb->createFunction('last_seq + 1'))
				->set('last_active', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
				->where($qb->expr()->eq('id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
				->executeStatement();
			$seq = (int)($this->sessionById($sessionId)['last_seq'] ?? 0);
			if ($base >= $seq) {
				throw new \InvalidArgumentException('the edit was made against a log position that does not exist yet');
			}
			$qb = $this->db->getQueryBuilder();
			$qb->insert('wordcraft_ops')->values([
				'session_id' => $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT),
				'seq' => $qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT),
				'client' => $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT),
				'client_seq' => $qb->createNamedParameter($clientSeq, IQueryBuilder::PARAM_INT),
				'base' => $qb->createNamedParameter($base, IQueryBuilder::PARAM_INT),
				'op' => $qb->createNamedParameter($op),
			])->executeStatement();
			$this->db->commit();
			return $seq;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			// The same push racing itself: the other attempt logged it.
			$again = $this->opSeq($sessionId, $client, $clientSeq);
			if ($again !== null) {
				return $again;
			}
			throw $e;
		}
	}

	/**
	 * The log entries after `$since` (up to MAX_BATCH), who's in the session and where, and where
	 * the file was last saved. `$selection` is this member's position now (JSON, or '' if
	 * unchanged): opaque to the server, WordLogic's caret and selection. `['rejoin' => true]` if
	 * the entries after `$since` are no longer kept.
	 */
	public function sync(int $sessionId, int $client, string $userId, int $since, string $selection = ''): array {
		$this->requireMember($sessionId, $client, $userId);
		$now = $this->time->getTime();
		$qb = $this->db->getQueryBuilder();
		$qb->update('wordcraft_members')
			->set('last_seen', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT));
		if ($selection !== '' && strlen($selection) <= self::MAX_SELECTION_BYTES && self::isJson($selection)) {
			$qb->set('selection', $qb->createNamedParameter($selection));
		}
		$qb->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('client', $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT)))
			->executeStatement();
		$session = $this->sessionById($sessionId);
		$entries = $this->entries($sessionId, $since, self::MAX_BATCH);
		$last = (int)($session['last_seq'] ?? 0);
		if ($since < $last && ($entries === [] || (int)$entries[0]['seq'] !== $since + 1)) {
			return ['rejoin' => true];
		}
		return [
			'entries' => $entries,
			'members' => $this->activeMembers($sessionId, $now),
			'checkpointSeq' => (int)($session['checkpoint_seq'] ?? 0),
			'checkpointEtag' => (string)($session['checkpoint_etag'] ?? ''),
		];
	}

	/**
	 * Records that the file was saved for the session at log position `$seq` with `$etag`.
	 * `$state` is WordLogic's snapshot of the shared document at `$seq` ('' for none): kept for
	 * people who join from this save, replacing the previous one. One over MAX_STATE_BYTES isn't
	 * kept (the save still counts: joiners then start from the file).
	 */
	public function checkpoint(int $sessionId, int $client, string $userId, int $seq, string $etag, string $state = ''): void {
		$this->requireMember($sessionId, $client, $userId);
		if (strlen($state) > self::MAX_STATE_BYTES) {
			$state = '';
		}
		// The snapshot first: once the checkpoint is recorded, a joiner may ask for it.
		if ($state !== '' && $seq > 0) {
			$this->snapshots->put($sessionId, $seq, $state);
		}
		$qb = $this->db->getQueryBuilder();
		$qb->update('wordcraft_sessions')
			->set('checkpoint_seq', $qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT))
			->set('checkpoint_etag', $qb->createNamedParameter(self::bareEtag($etag)))
			->set('last_active', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->lt('checkpoint_seq', $qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->lte($qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT), 'last_seq'))
			->executeStatement();
		// Only the snapshot of the checkpoint as it now stands is kept (this one, or a later one
		// another member recorded first).
		$this->snapshots->keepOnly($sessionId, (int)($this->sessionById($sessionId)['checkpoint_seq'] ?? 0));
		$qb = $this->db->getQueryBuilder();
		$qb->delete('wordcraft_ops')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->lte('seq', $qb->createNamedParameter($seq - self::KEEP_BEFORE_CHECKPOINT, IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}

	/**
	 * The state snapshot kept for log position `$seq`, for a member who joined at it.
	 * @throws StateGoneException when there's none (a later checkpoint replaced it: join again)
	 */
	public function state(int $sessionId, int $client, string $userId, int $seq): ISimpleFile {
		$this->requireMember($sessionId, $client, $userId);
		return $this->snapshots->get($sessionId, $seq) ?? throw new StateGoneException();
	}

	public function leave(int $sessionId, int $client, string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete('wordcraft_members')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('client', $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeStatement();
	}

	/** The file a session is for, or null. */
	public function fileOf(int $sessionId): ?int {
		$s = $this->sessionById($sessionId);
		return $s === null ? null : (int)$s['file_id'];
	}

	/**
	 * Removes sessions nobody uses any more, with their log, members and snapshot: idle for a
	 * day with everything saved to the file, or idle for a month. Returns how many went.
	 */
	public function cleanUp(): int {
		$now = $this->time->getTime();
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from('wordcraft_sessions')
			->where($qb->expr()->lt('last_active', $qb->createNamedParameter($now - self::IDLE_SECONDS, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->eq('last_seq', 'checkpoint_seq'),
				$qb->expr()->lt('last_active', $qb->createNamedParameter($now - self::ABANDONED_SECONDS, IQueryBuilder::PARAM_INT)),
			));
		$rows = $qb->executeQuery();
		$ids = [];
		while ($r = $rows->fetch()) {
			$ids[] = (int)$r['id'];
		}
		$rows->closeCursor();
		$removed = 0;
		foreach ($ids as $id) {
			if ($this->activeMembers($id, $now) !== []) {
				continue;
			}
			foreach (['wordcraft_ops', 'wordcraft_members'] as $table) {
				$qb = $this->db->getQueryBuilder();
				$qb->delete($table)->where($qb->expr()->eq('session_id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();
			}
			$qb = $this->db->getQueryBuilder();
			$qb->delete('wordcraft_sessions')->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();
			$this->snapshots->clear($id);
			$removed++;
		}
		return $removed;
	}

	/** An ETag without the quotes WebDAV puts around it. */
	public static function bareEtag(string $etag): string {
		return trim($etag, " \t\"");
	}

	/** Whether `$text` is a JSON object or array. */
	private static function isJson(string $text): bool {
		$value = json_decode($text);
		return is_object($value) || is_array($value);
	}

	private function requireMember(int $sessionId, int $client, string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$row = $qb->select('id')->from('wordcraft_members')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('client', $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->executeQuery()->fetch();
		if ($row === false) {
			throw new NotMemberException();
		}
	}

	/** @return list<array{seq: int, client: int, client_seq: int, base: int, op: string}> */
	private function entries(int $sessionId, int $since, int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('seq', 'client', 'client_seq', 'base', 'op')->from('wordcraft_ops')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->gt('seq', $qb->createNamedParameter($since, IQueryBuilder::PARAM_INT)))
			->orderBy('seq', 'ASC');
		if ($limit < PHP_INT_MAX) {
			$qb->setMaxResults($limit);
		}
		$out = [];
		$rows = $qb->executeQuery();
		while ($r = $rows->fetch()) {
			$out[] = ['seq' => (int)$r['seq'], 'client' => (int)$r['client'], 'client_seq' => (int)$r['client_seq'], 'base' => (int)$r['base'], 'op' => (string)$r['op']];
		}
		$rows->closeCursor();
		return $out;
	}

	/** @return list<array{client: int, userId: string, displayName: string, selection: string, canEdit: bool}> */
	private function activeMembers(int $sessionId, int $now): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('client', 'user_id', 'display_name', 'selection', 'can_edit')->from('wordcraft_members')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->gte('last_seen', $qb->createNamedParameter($now - self::ACTIVE_SECONDS, IQueryBuilder::PARAM_INT)))
			->orderBy('client', 'ASC');
		$out = [];
		$rows = $qb->executeQuery();
		while ($r = $rows->fetch()) {
			$out[] = [
				'client' => (int)$r['client'],
				'userId' => (string)$r['user_id'],
				'displayName' => (string)$r['display_name'],
				'selection' => (string)($r['selection'] ?? ''),
				'canEdit' => (int)($r['can_edit'] ?? 1) === 1,
			];
		}
		$rows->closeCursor();
		return $out;
	}

	private function opSeq(int $sessionId, int $client, int $clientSeq): ?int {
		$qb = $this->db->getQueryBuilder();
		$row = $qb->select('seq')->from('wordcraft_ops')
			->where($qb->expr()->eq('session_id', $qb->createNamedParameter($sessionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('client', $qb->createNamedParameter($client, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('client_seq', $qb->createNamedParameter($clientSeq, IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetch();
		return $row === false ? null : (int)$row['seq'];
	}

	private function sessionByFile(int $fileId): ?array {
		$qb = $this->db->getQueryBuilder();
		$row = $qb->select('*')->from('wordcraft_sessions')
			->where($qb->expr()->eq('file_id', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetch();
		return $row === false ? null : $row;
	}

	private function sessionById(int $id): ?array {
		$qb = $this->db->getQueryBuilder();
		$row = $qb->select('*')->from('wordcraft_sessions')
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetch();
		return $row === false ? null : $row;
	}
}

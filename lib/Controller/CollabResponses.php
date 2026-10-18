<?php

declare(strict_types=1);

namespace OCA\WordCraft\Controller;

use OCA\WordCraft\Service\CollabService;
use OCA\WordCraft\Service\NotMemberException;
use OCA\WordCraft\Service\StateGoneException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\FileDisplayResponse;
use OCP\AppFramework\Http\Response;
use OCP\Files\File;
use OCP\Files\SimpleFS\ISimpleFile;

/** How the co-editing endpoints answer: what a call returns or throws, as JSON. */
trait CollabResponses {
	/** Runs `$f`, turning what it returns or throws into a response (JSON, unless it's one). */
	private function guard(callable $f): Response {
		try {
			$out = $f();
			return $out instanceof Response ? $out : new DataResponse($out);
		} catch (NotMemberException $e) {
			return new DataResponse($e->outdated ? ['rejoin' => true, 'outdated' => true] : ['rejoin' => true], Http::STATUS_CONFLICT);
		} catch (StateGoneException) {
			return new DataResponse(['error' => 'The shared document was saved again: join again.', 'retry' => true], Http::STATUS_NOT_FOUND);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		} catch (NotAllowed $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}
	}

	private static function viewOnly(): DataResponse {
		return new DataResponse(['error' => 'You can view this file but not edit it.'], Http::STATUS_FORBIDDEN);
	}

	/** A state snapshot, as WordLogic handed it over. */
	private static function snapshot(ISimpleFile $file): FileDisplayResponse {
		return new FileDisplayResponse($file, Http::STATUS_OK, [
			'Content-Type' => 'application/json; charset=utf-8',
			'Cache-Control' => 'no-store',
		]);
	}

	/**
	 * A checkpoint is recorded only for the save it describes: the file must have the ETag the
	 * member says it saved (otherwise the state snapshot could be anything).
	 */
	private static function requireSaved(File $file, string $etag): void {
		if (CollabService::bareEtag((string)$file->getEtag()) !== CollabService::bareEtag($etag)) {
			throw new \InvalidArgumentException('the file has changed since that save');
		}
	}
}

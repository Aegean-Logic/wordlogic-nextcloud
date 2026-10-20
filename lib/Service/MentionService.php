<?php

declare(strict_types=1);

namespace OCA\WordCraft\Service;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Controller\NotAllowed;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\IAppConfig;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\IUserManager;
use OCP\L10N\IFactory;
use OCP\Mail\IMailer;
use OCP\Notification\IManager as INotificationManager;
use Psr\Log\LoggerInterface;

/**
 * @mentions in WordLogic's comments, as Microsoft 365 sends them: each person mentioned who can
 * open the document gets a notification and an email with the comment and a link to it. People
 * who can't open it are only reported back, so the editor can offer to share it first.
 *
 * Also @mentions in the document's chat (Talk, beside the editor) of people the message brought
 * into the chat: Talk adds them as read up to that message, so its own notification is dropped
 * (Talk 24). Everyone already in the chat hears from Talk. And a call started about the document,
 * for the people in its chat: Talk sends no call notifications for a file's conversation.
 */
class MentionService {
	/** People told about one comment, at most. */
	public const MAX_PEOPLE = 20;
	/** The comment text carried, at most (characters). */
	public const MAX_TEXT = 1000;
	/** A comment's address in the document (its durable id), at most (characters). */
	public const MAX_ANCHOR = 300;
	/** Where the mention is: a comment in the file, or the file's chat. */
	public const IN_COMMENT = 'comment';
	public const IN_CHAT = 'chat';
	/** Not a mention: a call about the file started (no email: it's now or never). */
	public const CALL_STARTED = 'call';

	public function __construct(
		private IRootFolder $rootFolder,
		private IUserManager $userManager,
		private INotificationManager $notifications,
		private IMailer $mailer,
		private IURLGenerator $url,
		private IFactory $l10nFactory,
		private IAppConfig $appConfig,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * Tells `$uids` that `$actor` mentioned them in a comment of file `$fileId` (`$where`
	 * {@see IN_COMMENT}), or in its chat ({@see IN_CHAT}), or started a call about it
	 * ({@see CALL_STARTED}).
	 *
	 * @param list<mixed> $uids
	 * @return array{notified: list<string>, noAccess: list<array{id: string, name: string}>}
	 */
	public function notify(IUser $actor, int $fileId, array $uids, string $text, string $anchor, string $where = self::IN_COMMENT): array {
		if (!in_array($where, [self::IN_COMMENT, self::IN_CHAT, self::CALL_STARTED], true)) {
			throw new \InvalidArgumentException('Unknown place for a mention.');
		}
		if ($where !== self::IN_COMMENT) {
			$anchor = '';
		}
		if ($where === self::CALL_STARTED) {
			$text = '';
		}
		$own = $this->rootFolder->getUserFolder($actor->getUID())->getFirstNodeById($fileId);
		if ($own === null || !$own->isReadable()) {
			throw new NotAllowed('The file is not available.');
		}
		$text = mb_substr(trim($text), 0, self::MAX_TEXT);
		$anchor = mb_substr(trim($anchor), 0, self::MAX_ANCHOR);
		$wanted = [];
		foreach ($uids as $uid) {
			if (is_string($uid) && $uid !== '' && strlen($uid) <= 64 && $uid !== $actor->getUID()) {
				$wanted[$uid] = true;
			}
		}
		if (count($wanted) > self::MAX_PEOPLE) {
			throw new \InvalidArgumentException('Mention at most ' . self::MAX_PEOPLE . ' people in one comment.');
		}
		$notified = [];
		$noAccess = [];
		foreach (array_keys($wanted) as $uid) {
			$uid = (string)$uid;
			$user = $this->userManager->get($uid);
			if ($user === null || !$user->isEnabled()) {
				continue;
			}
			$node = $this->rootFolder->getUserFolder($uid)->getFirstNodeById($fileId);
			if ($node === null || !$node->isReadable()) {
				$noAccess[] = ['id' => $uid, 'name' => $user->getDisplayName()];
				continue;
			}
			$path = $this->rootFolder->getUserFolder($uid)->getRelativePath($node->getPath()) ?? ('/' . $node->getName());
			$this->notification($actor, $user, $fileId, $node, $path, $text, $anchor, $where);
			$this->email($actor, $user, $node, $path, $text, $anchor, $where);
			$notified[] = $uid;
		}
		return ['notified' => $notified, 'noAccess' => $noAccess];
	}

	/** Where the comment (or the chat) opens for someone whose copy of the file is at `$path`. */
	public function link(string $path, string $anchor, string $where = self::IN_COMMENT): string {
		$params = ['path' => ltrim($path, '/')];
		if ($where === self::IN_CHAT || $where === self::CALL_STARTED) {
			$params['chat'] = '1';
		} elseif ($anchor !== '') {
			$params['comment'] = $anchor;
		}
		return $this->url->linkToRouteAbsolute(Application::APP_ID . '.editor.edit', $params);
	}

	private function notification(IUser $actor, IUser $user, int $fileId, Node $node, string $path, string $text, string $anchor, string $where): void {
		$n = $this->notifications->createNotification();
		$n->setApp(Application::APP_ID)
			->setUser($user->getUID())
			->setDateTime(new \DateTime())
			->setObject('file', (string)$fileId)
			->setSubject('mention', [
				'actor' => $actor->getUID(),
				'actorName' => $actor->getDisplayName(),
				'fileId' => $fileId,
				'name' => $node->getName(),
				'path' => $path,
				'anchor' => $anchor,
				'where' => $where,
			])
			->setMessage('comment', ['text' => mb_substr($text, 0, 300)]);
		$this->notifications->notify($n);
	}

	private function email(IUser $actor, IUser $user, Node $node, string $path, string $text, string $anchor, string $where): void {
		$to = $user->getEMailAddress();
		if ($where === self::CALL_STARTED || $to === null || $to === '' || $this->appConfig->getValueString(Application::APP_ID, 'mention_email', 'yes') === 'no') {
			return;
		}
		try {
			$l = $this->l10nFactory->get(Application::APP_ID, $this->l10nFactory->getUserLanguage($user));
			$who = $actor->getDisplayName();
			$file = $node->getName();
			$template = $this->mailer->createEMailTemplate(Application::APP_ID . '.Mention', ['actor' => $who, 'file' => $file]);
			$template->setSubject($l->t('%1$s mentioned you in %2$s', [$who, $file]));
			$template->addHeader();
			$chat = $where === self::IN_CHAT;
			$template->addHeading($chat
				? $l->t('%1$s mentioned you in the chat about %2$s', [$who, $file])
				: $l->t('%1$s mentioned you in a comment', [$who]));
			$template->addBodyText($l->t('In %s:', [$file]));
			if ($text !== '') {
				$template->addBodyText($text);
			}
			$template->addBodyButton($chat ? $l->t('Go to chat') : $l->t('Go to comment'), $this->link($path, $anchor, $where));
			$template->addFooter();
			$message = $this->mailer->createMessage();
			$message->setTo([$to => $user->getDisplayName()]);
			$message->useTemplate($template);
			$this->mailer->send($message);
		} catch (\Throwable $e) {
			// The notification went; a mail server that's down mustn't fail the comment.
			$this->logger->warning('WordLogic could not email a mention', ['exception' => $e, 'app' => Application::APP_ID]);
		}
	}
}

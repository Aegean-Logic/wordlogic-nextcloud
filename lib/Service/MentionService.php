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
 */
class MentionService {
	/** People told about one comment, at most. */
	public const MAX_PEOPLE = 20;
	/** The comment text carried, at most (characters). */
	public const MAX_TEXT = 1000;
	/** A comment's address in the document (its durable id), at most (characters). */
	public const MAX_ANCHOR = 300;

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
	 * Tells `$uids` that `$actor` mentioned them in a comment of file `$fileId`.
	 *
	 * @param list<mixed> $uids
	 * @return array{notified: list<string>, noAccess: list<array{id: string, name: string}>}
	 */
	public function notify(IUser $actor, int $fileId, array $uids, string $text, string $anchor): array {
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
			$this->notification($actor, $user, $fileId, $node, $path, $text, $anchor);
			$this->email($actor, $user, $node, $path, $text, $anchor);
			$notified[] = $uid;
		}
		return ['notified' => $notified, 'noAccess' => $noAccess];
	}

	/** Where the comment opens for someone whose copy of the file is at `$path`. */
	public function link(string $path, string $anchor): string {
		$params = ['path' => ltrim($path, '/')];
		if ($anchor !== '') {
			$params['comment'] = $anchor;
		}
		return $this->url->linkToRouteAbsolute(Application::APP_ID . '.editor.edit', $params);
	}

	private function notification(IUser $actor, IUser $user, int $fileId, Node $node, string $path, string $text, string $anchor): void {
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
			])
			->setMessage('comment', ['text' => mb_substr($text, 0, 300)]);
		$this->notifications->notify($n);
	}

	private function email(IUser $actor, IUser $user, Node $node, string $path, string $text, string $anchor): void {
		$to = $user->getEMailAddress();
		if ($to === null || $to === '' || $this->appConfig->getValueString(Application::APP_ID, 'mention_email', 'yes') === 'no') {
			return;
		}
		try {
			$l = $this->l10nFactory->get(Application::APP_ID, $this->l10nFactory->getUserLanguage($user));
			$who = $actor->getDisplayName();
			$file = $node->getName();
			$template = $this->mailer->createEMailTemplate(Application::APP_ID . '.Mention', ['actor' => $who, 'file' => $file]);
			$template->setSubject($l->t('%1$s mentioned you in %2$s', [$who, $file]));
			$template->addHeader();
			$template->addHeading($l->t('%1$s mentioned you in a comment', [$who]));
			$template->addBodyText($l->t('In %s:', [$file]));
			if ($text !== '') {
				$template->addBodyText($text);
			}
			$template->addBodyButton($l->t('Go to comment'), $this->link($path, $anchor));
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

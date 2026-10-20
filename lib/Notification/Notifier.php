<?php

declare(strict_types=1);

namespace OCA\WordCraft\Notification;

use OCA\WordCraft\AppInfo\Application;
use OCA\WordCraft\Service\MentionService;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;
use OCP\Notification\INotification;
use OCP\Notification\INotifier;
use OCP\Notification\UnknownNotificationException;

/**
 * Shows WordLogic's notifications: "Ann mentioned you in Report.docx", with the comment, "Ann
 * mentioned you in the chat about Report.docx", with the message, or "Ann started a call about
 * Report.docx".
 */
class Notifier implements INotifier {
	public function __construct(
		private IFactory $l10nFactory,
		private IURLGenerator $url,
		private MentionService $mentions,
	) {
	}

	public function getID(): string {
		return Application::APP_ID;
	}

	public function getName(): string {
		return $this->l10nFactory->get(Application::APP_ID)->t('WordLogic');
	}

	public function prepare(INotification $notification, string $languageCode): INotification {
		if ($notification->getApp() !== Application::APP_ID || $notification->getSubject() !== 'mention') {
			throw new UnknownNotificationException();
		}
		$l = $this->l10nFactory->get(Application::APP_ID, $languageCode);
		$p = $notification->getSubjectParameters();
		$actor = (string)($p['actor'] ?? '');
		$actorName = (string)($p['actorName'] ?? $actor);
		$name = (string)($p['name'] ?? '');
		$path = (string)($p['path'] ?? '');
		$where = (string)($p['where'] ?? MentionService::IN_COMMENT);
		$link = $this->mentions->link($path, (string)($p['anchor'] ?? ''), $where);
		$subject = match ($where) {
			MentionService::IN_CHAT => $l->t('{user} mentioned you in the chat about {file}'),
			MentionService::CALL_STARTED => $l->t('{user} started a call about {file}'),
			default => $l->t('{user} mentioned you in {file}'),
		};
		$notification->setRichSubject($subject, [
			'user' => ['type' => 'user', 'id' => $actor, 'name' => $actorName],
			'file' => ['type' => 'file', 'id' => (string)($p['fileId'] ?? ''), 'name' => $name, 'path' => ltrim($path, '/'), 'link' => $link],
		]);
		$notification->setParsedSubject(str_replace(['{user}', '{file}'], [$actorName, $name], $subject));
		$text = (string)($notification->getMessageParameters()['text'] ?? '');
		if ($text !== '') {
			$notification->setParsedMessage($text);
		}
		$notification->setLink($link);
		$notification->setIcon($this->url->getAbsoluteURL($this->url->imagePath('core', 'actions/comment.svg')));
		return $notification;
	}
}

<?php
/** @var array $_ */
?>
<div id="wordcraft-app"
	data-path="<?php p($_['path']); ?>"
	data-file-id="<?php p((string)$_['fileId']); ?>"
	<?php if (isset($_['shareToken'])) { ?>
	data-share-token="<?php p($_['shareToken']); ?>"
	data-file-name="<?php p($_['fileName']); ?>"
	data-can-edit="<?php p($_['canEdit'] ? '1' : '0'); ?>"
	<?php } ?>
	data-editor-url="<?php p($_['editorUrl']); ?>"
	data-editor-missing="<?php p(!empty($_['editorMissing']) ? '1' : '0'); ?>">
	<p id="wordcraft-status">Loading WordLogic…</p>
</div>

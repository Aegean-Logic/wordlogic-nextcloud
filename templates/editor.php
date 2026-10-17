<?php
/** @var array $_ */
?>
<div id="wordcraft-app"
	data-path="<?php p($_['path']); ?>"
	data-file-id="<?php p((string)$_['fileId']); ?>"
	data-editor-url="<?php p($_['editorUrl']); ?>"
	data-editor-missing="<?php p(!empty($_['editorMissing']) ? '1' : '0'); ?>">
	<p id="wordcraft-status">Loading WordLogic…</p>
</div>

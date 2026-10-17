<?php
/** @var array $_ */
?>
<div id="wordcraft-app"
	data-path="<?php p($_['path']); ?>"
	data-editor-url="<?php p($_['editorUrl']); ?>"
	data-editor-missing="<?php p(!empty($_['editorMissing']) ? '1' : '0'); ?>">
	<p id="wordcraft-status">Loading WordLogic…</p>
</div>

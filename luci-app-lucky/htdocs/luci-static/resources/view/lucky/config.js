'use strict';
// SPDX-License-Identifier: Apache-2.0
'require view';
'require form';
'require rpc';
'require ui';
'require fs';
'require request';

var HELPER = '/usr/libexec/lucky-call';
// Keep the fast status request out of the slow binary-query RPC batch.
var callHelper = rpc.declare({
	object: 'file',
	method: 'exec',
	params: [ 'command', 'params' ],
	nobatch: true
});
var resetInProgress = false;
var refreshInProgress = false;
var backupInProgress = false;
var state = {
	installed: false,
	core: "unknown",
	running: false,
	infoReady: false,
	configReady: false,
	runtimeReady: false,
	loading: true,
	error: null,
	arch: '-',
	version: '-',
	date: '-',
	port: 16601,
	safeURL: '',
	allowInternet: false
};

function helper(args, program) {
	return callHelper(program || HELPER, args).then(function(res) {
		if (!res || typeof res !== 'object')
			throw new Error(rpc.getStatusText(res));
		if (typeof res.code === 'number' && res.code !== 0) {
			var detail = (res.stderr || res.stdout || _('The operation failed.')).trim();
			throw new Error(detail.substring(0, 400));
		}
		return (res.stdout || '').trim();
	});
}

function parseJSON(value, source) {
	try {
		return JSON.parse(value);
	}
	catch (e) {
		throw new Error(_('Invalid response from %s.').format(source));
	}
}

function loadState() {
	if (refreshInProgress || backupInProgress)
		return Promise.resolve();
	refreshInProgress = true;
	state.loading = true;
	state.error = null;
	state.configReady = false;
	state.installed = false;
	state.infoReady = false;
	state.version = state.date = "-";
	updateDashboard(false);
	function failed(err) {
		state.error = err && err.message ? err.message : _('Unable to load Lucky data.');
		updateDashboard(false);
	}

	return Promise.all([
		helper([ 'core-status' ], '/usr/libexec/lucky-backup').then(function(value) {
			var core = parseJSON(value, 'Core status');
			if (!core.ok) throw new Error(core.error || _('Unable to inspect core.'));
			state.core = core.status;
			updateDashboard(false);
		}).catch(function(err) { state.core = 'unknown'; failed(err); }),
		helper([ 'info' ]).then(function(value) {
			var info = parseJSON(value, 'Lucky -info');
			state.installed = true;
			state.infoReady = true;
			state.version = info.Version || '-';
			state.date = info.Date || '-';
			updateDashboard(false);
		}).catch(failed),
		helper([ 'base' ]).then(function(value) {
			var base = parseJSON(value, 'Lucky -baseConfInfo');
			var config = base.BaseConfigure || {};
			var port = Number(config.AdminWebListenPort);
			state.installed = true;
			state.configReady = true;
			state.port = Math.floor(port) === port && port >= 1 && port <= 65535 ? port : 16601;
			state.safeURL = typeof config.SafeURL === 'string' ? config.SafeURL : '';
			state.allowInternet = config.AllowInternetaccess === true;
			updateDashboard(true);
		}).catch(failed),
		helper([ 'status' ]).then(function(value) {
			state.running = value === 'true';
			state.runtimeReady = true;
			updateRuntimeStatus();
		}).catch(failed),
		helper([ 'arch' ]).then(function(value) {
			state.arch = value || '-';
			updateText('lucky-arch', state.arch);
		}).catch(failed)
	]).then(function() {
		state.loading = false;
		refreshInProgress = false;
		updateDashboard(false);
		return state;
	});
}

function notifyError(err) {
	var message = err && err.message ? err.message : _('The operation failed.');
	ui.addNotification(null, E('p', {}, message));
}

function action(args, successMessage) {
	return helper(args).then(function() {
		ui.addNotification(null, E('p', {}, successMessage), 'info');
		return loadState();
	}).catch(notifyError);
}

function textRow(label, id) {
	return E('div', { 'class': 'lucky-stat' }, [
		E('div', { 'class': 'lucky-label' }, label),
		E('div', { 'class': 'lucky-value', 'id': id }, _('Collecting data…'))
	]);
}

function serviceButton(label, css, operation) {
	return E('button', {
		'class': 'btn cbi-button ' + css,
		'id': 'lucky-service-' + operation,
		'type': 'button',
		'click': function() {
			if (!window.confirm(_('Are you sure you want to perform this service action?')))
				return;
			action([ 'service', operation ], _('Lucky service state updated.'));
		}
	}, label);
}

function hostForURL() {
	var host = window.location.hostname;
	return host.indexOf(':') > -1 && host.charAt(0) !== '[' ? '[' + host + ']' : host;
}

function adminURL() {
	return 'http://' + hostForURL() + ':' + state.port + state.safeURL;
}

function updateText(id, value, css) {
	var node = document.getElementById(id);
	if (!node)
		return;
	node.textContent = value;
	node.className = 'lucky-value' + (css ? ' lucky-state-' + css : '');
}

function setDisabled(id, disabled) {
	var node = document.getElementById(id);
	if (node)
		node.disabled = disabled;
}

function updateRuntimeStatus() {
	updateText('lucky-running', !state.runtimeReady ? _('Collecting data…') : (state.running ? _('Running') : _('Stopped')), !state.runtimeReady ? '' : (state.running ? 'success' : 'error'));

	var link = document.getElementById('lucky-admin-link');
	var accessible = state.runtimeReady && state.running && state.configReady;
	if (link) {
		link.textContent = accessible ? _('Open admin panel') : (state.loading ? _('Collecting data…') : _('Available when the service is running'));
		updateText('lucky-admin-address', accessible ? adminURL() : '');
		link.style.pointerEvents = accessible ? '' : 'none';
		link.setAttribute('aria-disabled', accessible ? 'false' : 'true');
		if (accessible) {
			link.href = adminURL();
			link.removeAttribute('tabindex');
		}
		else {
			link.removeAttribute('href');
			link.setAttribute('tabindex', '-1');
		}
	}

	setDisabled('lucky-service-start', !state.installed || !state.runtimeReady || refreshInProgress || state.running);
	setDisabled('lucky-service-restart', !state.installed || !state.runtimeReady || refreshInProgress);
	setDisabled('lucky-service-stop', !state.runtimeReady || refreshInProgress || !state.running);
}

function updateDashboard(updateInputs) {
	var refresh = document.getElementById('lucky-refresh');
	if (refresh) {
		refresh.disabled = refreshInProgress || resetInProgress;
		refresh.textContent = refreshInProgress ? _('Refreshing…') : _('Refresh');
	}
	updateText('lucky-install', state.error ? _('Load error: %s').format(state.error) : (state.installed ? _('Installed') : (state.loading ? _('Collecting data…') : _('Not installed'))), state.error ? 'error' : (state.installed ? 'success' : ''));
	var health = { ready: _('Executable'), missing: _('Core missing'), permissions: _('Execution permission missing'), unsafe: _('Unsafe core path'), unknown: _('Unable to inspect core.') };
	updateText('lucky-core-health', health[state.core] || health.unknown);
	setDisabled('lucky-core-fix', state.core !== 'permissions' || refreshInProgress || backupInProgress || resetInProgress);
	setDisabled('lucky-core-upload', refreshInProgress || backupInProgress || resetInProgress);
	if (state.core === 'missing' || state.core === 'permissions' || state.core === 'unsafe')
		updateText('lucky-install', health[state.core], 'error');
	updateText('lucky-arch', state.arch);
	updateText('lucky-version', !state.infoReady && state.loading ? _('Collecting data…') : state.version);
	updateText('lucky-date', !state.infoReady && state.loading ? _('Collecting data…') : state.date);
	updateText('lucky-internet', !state.configReady ? (state.loading ? _('Collecting data…') : '-') : (state.allowInternet ? _('Allowed') : _('Local access only')), state.configReady && state.allowInternet ? 'warning' : '');

	var port = document.getElementById('lucky-port');
	var safeURL = document.getElementById('lucky-safe-url');
	var internet = document.getElementById('lucky-allow-internet');
	if (port && updateInputs)
		port.value = state.port;
	if (safeURL && updateInputs)
		safeURL.value = state.safeURL;
	if (internet && updateInputs)
		internet.checked = state.allowInternet;

	setDisabled('lucky-port', !state.configReady);
	setDisabled('lucky-safe-url', !state.configReady);
	setDisabled('lucky-allow-internet', !state.configReady);
	setDisabled('lucky-save-port', !state.configReady || refreshInProgress);
	setDisabled('lucky-save-safe-url', !state.configReady || refreshInProgress);
	setDisabled('lucky-save-internet', !state.configReady || refreshInProgress);
	setDisabled('lucky-reset-auth', !state.configReady || refreshInProgress || resetInProgress);
	setDisabled('lucky-backup', !state.installed || refreshInProgress || resetInProgress || backupInProgress);
	setDisabled('lucky-restore', !state.installed || refreshInProgress || resetInProgress || backupInProgress);
	setDisabled('lucky-clear', !state.installed || refreshInProgress || resetInProgress || backupInProgress);
	updateRuntimeStatus();
}

function archiveCall(operation, token) {
	// cgi-exec avoids ubus output/time limits. The long-running operation owns
	// service recovery, so it does not depend on a second browser request.
	var command = '/usr/libexec/lucky-backup ' + operation + (token ? ' ' + token : '');
	return request.post(L.env.cgi_base + '/cgi-exec',
		'sessionid=' + encodeURIComponent(rpc.getSessionID()) + '&command=' + encodeURIComponent(command), {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 0
		}).then(function(response) {
			if (response.status !== 200)
				throw new Error(_('Backup operation failed.'));
			var result = response.json();
			if (result.warning)
				ui.addNotification(null, E('p', {}, result.warning), 'warning');
			if (!result.ok)
				throw new Error(result.error || _('Backup operation failed.'));
			return result;
		});
}

function coreMaintenance(upload) {
	if (backupInProgress || refreshInProgress || resetInProgress) return Promise.resolve();
	if (upload && !window.confirm(_('Upload a trusted Lucky Linux tar.gz release for this device. Only the core executable will be replaced; configuration is preserved. Continue?')))
		return Promise.resolve();
	backupInProgress = true;
	var token, saved = [];
	Array.prototype.forEach.call(document.querySelectorAll('.lucky-page button, .lucky-page input, .lucky-page select'), function(node) {
		saved.push([node, node.disabled]); node.disabled = true;
	});
	return (upload ? archiveCall('core-prepare').then(function(result) {
		if (!/^[a-f0-9]{32}$/.test(result.token)) throw new Error(_('Backup operation failed.'));
		token = result.token;
		return ui.uploadFile('/tmp/lucky-luci-backup/' + token + '/core.tar.gz');
	}).then(function() {
		ui.showModal(_('Core maintenance'), [ E('p', { 'class': 'spinning' }, _('Checking core archive and architecture…')) ]);
		return archiveCall('core-check', token);
	}).then(function(info) {
		return new Promise(function(resolve) {
			ui.showModal(_('Replace core'), [
				E('p', {}, _('New core version: %s').format(info.version)),
				E('p', {}, _('Only /usr/bin/lucky will be replaced. Lucky will stop during replacement and resume only if it was running. Configuration files are preserved.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'type': 'button', 'class': 'btn', 'click': function() { resolve(false); } }, _('Cancel')), ' ',
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative', 'click': function() { resolve(true); } }, _('Replace core'))
				])
			]);
		});
	}).then(function(confirmed) {
		if (!confirmed) return;
		ui.showModal(_('Core maintenance'), [ E('p', { 'class': 'spinning' }, _('Replacing core…')) ]);
		return archiveCall('core-install', token).then(function() {
			ui.addNotification(null, E('p', {}, _('Core replaced.')), 'info');
		});
	}) : archiveCall('core-fix').then(function() {
		ui.addNotification(null, E('p', {}, _('Core execution permissions repaired.')), 'info');
	})).catch(notifyError).then(function() {
		return token ? archiveCall('cleanup', token).catch(notifyError) : null;
	}).then(function() {
		ui.hideModal(); backupInProgress = false;
		saved.forEach(function(item) { item[0].disabled = item[1]; });
		return loadState();
	});
}

function confirmRestore(info, clearing) {
	return new Promise(function(resolve) {
		function choose(value) { ui.hideModal(); resolve(value); }
		function files(label, names) {
			names = Array.isArray(names) ? names : [];
			return E('details', { 'open': names.length ? '' : null }, [
				E('summary', {}, label + ' (' + names.length + ')'),
				E('pre', { 'class': 'lucky-archive-list' }, names.length ? names.join('\n') : _('None'))
			]);
		}
		ui.showModal(clearing ? _('Clear configuration') : _('Confirm full-directory restore'), [
			E('p', {}, _('Configuration directory: %s').format(info.directory)),
			E('p', {}, clearing ? _('This permanently deletes ALL files, including hidden files and subdirectories. Back up first. Lucky will remain stopped after clearing; start it manually to create fresh configuration.') : _('This will stop Lucky and replace ALL files in the saved configuration directory. Files absent from the backup will be deleted. Continue?')),
			files(_('Files to delete'), info.removed),
			clearing ? '' : files(_('Files to replace'), info.replaced),
			clearing ? '' : files(_('Files to create'), info.added),
			E('div', { 'class': 'right' }, [
				E('button', { 'type': 'button', 'class': 'btn', 'click': function() { choose(false); } }, _('Cancel')),
				' ', E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative',
					'click': function() { choose(true); } }, clearing ? _('Confirm clear') : _('Confirm restore'))
			])
		]);
	});
}

function configurationArchive(restore) {
	var clearing = restore === 'clear';
	if (backupInProgress || refreshInProgress || resetInProgress)
		return Promise.resolve();
	if (!restore && !window.confirm(_('Lucky will be stopped while creating the backup. Continue?')))
		return Promise.resolve();
	backupInProgress = true;
	var token, savedButtons = [];
	Array.prototype.forEach.call(document.querySelectorAll('.lucky-page button, .lucky-page input, .lucky-page select'), function(node) {
		savedButtons.push([node, node.disabled]);
		node.disabled = true;
	});
	var status = document.getElementById('lucky-backup-status');
	status.textContent = clearing ? _('Checking configuration directory…') : restore ? _('Select a LuCI directory backup to restore.') : _('Stopping Lucky and creating backup…');
	if (!restore)
		ui.showModal(_('Configuration backup and restore'), [ E('p', { 'class': 'spinning' }, status.textContent) ]);
	return archiveCall('prepare').then(function(result) {
		if (!/^[a-f0-9]{32}$/.test(result.token))
			throw new Error(_('Backup operation failed.'));
		token = result.token;
		if (!restore) {
			return archiveCall('backup', token).then(function(result) {
				return fs.read_direct('/tmp/lucky-luci-backup/' + token + '/backup.zip', 'blob').then(function(blob) {
					var url = URL.createObjectURL(blob);
					var link = E('a', { href: url, download: result.filename });
					document.body.appendChild(link);
					link.click();
					link.parentNode.removeChild(link);
					window.setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
					ui.addNotification(null, E('p', {}, _('Configuration backup downloaded.')), 'info');
				});
			});
		}
		return (clearing ? archiveCall('clear-check', token) : ui.uploadFile('/tmp/lucky-luci-backup/' + token + '/upload.zip').then(function() {
			status.textContent = _('Checking backup…');
			ui.showModal(_('Configuration backup and restore'), [ E('p', { 'class': 'spinning' }, status.textContent) ]);
			return archiveCall('check', token);
		})).then(function(info) {
			return confirmRestore(info, clearing).then(function(confirmed) {
				if (!confirmed) return;
				status.textContent = clearing ? _('Stopping Lucky and clearing configuration…') : _('Stopping Lucky and restoring configuration…');
				ui.showModal(_('Configuration backup and restore'), [ E('p', { 'class': 'spinning' }, status.textContent) ]);
				return archiveCall(clearing ? 'clear' : 'restore', token).then(function() {
					ui.addNotification(null, E('p', {}, clearing ? _('Configuration cleared. Lucky remains stopped. Start it manually when ready.') : _('Configuration restored.')), 'info');
				});
			});
		});
	}).catch(notifyError).then(function() {
		return token ? archiveCall('cleanup', token).catch(notifyError) : null;
	}).then(function() {
		ui.hideModal();
		backupInProgress = false;
		savedButtons.forEach(function(item) { item[0].disabled = item[1]; });
		status.textContent = '';
		return loadState();
	});
}

function showResetCredentials(result) {
	ui.showModal(_('Admin credentials reset'), [
		E('p', {}, _('Internet access was disabled before the credentials were changed.')),
		result.restarted ? '' : E('p', { 'class': 'alert-message warning' },
			_('Lucky could not restart automatically. Restart it manually after saving this password.')),
		E('p', {}, [ E('strong', {}, _('Account:')), ' ' + result.account ]),
		E('p', {}, [ E('strong', {}, _('New password:')), ' ', E('code', {}, result.password) ]),
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-primary',
				'type': 'button',
				'click': ui.hideModal
			}, _('Close'))
		])
	]);

	return loadState();
}

function resetCredentials() {
	if (resetInProgress)
		return Promise.resolve();

	resetInProgress = true;
	setDisabled('lucky-refresh', true);
	setDisabled('lucky-reset-auth', true);
	return helper([ 'reset-auth' ]).then(function(output) {
		var result = parseJSON(output, 'lucky-call reset-auth');
		if (result.account !== 'admin' || !/^[0-9a-f]{24}$/.test(result.password) || typeof result.restarted !== 'boolean')
			throw new Error(_('Lucky returned an invalid temporary password.'));
		return showResetCredentials(result);
	}).catch(notifyError).then(function() {
		resetInProgress = false;
		setDisabled('lucky-refresh', refreshInProgress);
		setDisabled('lucky-reset-auth', !state.configReady || refreshInProgress);
	});
}

function renderDashboard() {
	var dashboard = E('div', { 'class': 'lucky-dashboard' }, [
		// LuCI versions its view scripts, but custom stylesheet URLs need their own revision.
		E('link', { 'rel': 'stylesheet', 'href': L.resource('view/lucky/config.css') + '?v=3.0.0-7' }),
		E('div', { 'class': 'lucky-heading' }, [
			E('div', {}, [ E('h2', {}, _('Lucky')), E('p', {}, _('Service and admin panel')) ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-reload', 'id': 'lucky-refresh', 'type': 'button',
				'click': function() { return loadState(); }
			}, _('Refresh'))
		]),
		E('section', { 'class': 'lucky-panel', 'aria-label': _('Service overview') }, [
			E('h3', {}, _('Service overview')),
			E('div', { 'class': 'lucky-stats', 'role': 'status', 'aria-live': 'polite' }, [
				textRow(_('Installation status'), 'lucky-install'),
				textRow(_('Running status'), 'lucky-running'),
				textRow(_('Package architecture'), 'lucky-arch'),
				textRow(_('Lucky version'), 'lucky-version'),
				textRow(_('Build date'), 'lucky-date'),
				textRow(_('Admin access policy'), 'lucky-internet')
			]),
			E('div', { 'class': 'lucky-actions' }, [
				serviceButton(_('Start'), 'cbi-button-apply', 'start'),
				serviceButton(_('Restart'), 'cbi-button-reload', 'restart'),
				serviceButton(_('Stop'), 'cbi-button-reset', 'stop')
			])
		]),
		E('section', { 'class': 'lucky-panel', 'aria-label': _('Admin panel') }, [
			E('h3', {}, _('Admin panel')),
			E('a', {
				'class': 'lucky-admin-link',
				'id': 'lucky-admin-link',
				'target': '_blank',
				'rel': 'noopener noreferrer',
				'aria-disabled': 'true',
				'tabindex': '-1'
			}, _('Available when the service is running')),
			E('div', { 'id': 'lucky-admin-address', 'class': 'lucky-value' }),
			E('details', { 'class': 'lucky-settings' }, [
				E('summary', {}, _('Access settings')),
				E('p', { 'class': 'lucky-hint' }, _('Save changes, then restart Lucky to apply them.')),
				E('div', { 'class': 'lucky-inline' }, [
					E('label', { 'for': 'lucky-port' }, _('Admin HTTP port')),
					E('input', { 'id': 'lucky-port', 'class': 'cbi-input-text', 'type': 'number', 'min': '1', 'max': '65535' }),
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'id': 'lucky-save-port',
						'type': 'button',
						'click': function() {
							var port = document.getElementById('lucky-port').value;
							if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
								notifyError(new Error(_('Enter a port from 1 to 65535.')));
								return;
							}
							action([ 'set-port', port ], _('Admin port updated. Restart Lucky to apply it.'));
						}
					}, _('Save'))
				]),
				E('div', { 'class': 'lucky-inline' }, [
					E('label', { 'for': 'lucky-safe-url' }, _('Admin safe URL')),
					E('input', { 'id': 'lucky-safe-url', 'class': 'cbi-input-text', 'type': 'text', 'maxlength': '256', 'placeholder': '/secret-path' }),
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'id': 'lucky-save-safe-url',
						'type': 'button',
						'click': function() {
							var value = document.getElementById('lucky-safe-url').value;
							if (value && (value.charAt(0) !== '/' || /\s/.test(value))) {
								notifyError(new Error(_('The safe URL must be empty or begin with / and contain no spaces.')));
								return;
							}
							action([ 'set-safe-url', value ], _('Admin safe URL updated. Restart Lucky to apply it.'));
						}
					}, _('Save'))
				]),
				E('div', { 'class': 'lucky-inline' }, [
					E('label', { 'for': 'lucky-allow-internet' }, _('Allow Internet access to the admin panel')),
					E('input', { 'id': 'lucky-allow-internet', 'type': 'checkbox' }),
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'id': 'lucky-save-internet',
						'type': 'button',
						'click': function() {
							var enabled = document.getElementById('lucky-allow-internet').checked;
							if (enabled && !window.confirm(_('Exposing the admin panel to the Internet increases risk. Continue?')))
								return;
							action([ 'set-internet', enabled ? 'true' : 'false' ], _('Admin access policy updated. Restart Lucky to apply it.'));
						}
					}, _('Save'))
				]),
				E('div', { 'class': 'lucky-reset' }, [
					E('p', { 'class': 'lucky-hint' }, _('Only reset credentials if you cannot sign in.')),
					E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'id': 'lucky-reset-auth',
						'type': 'button',
						'click': function() {
							if (window.confirm(_('Reset the Lucky admin account and generate a new password?')))
								resetCredentials();
						}
					}, _('Reset admin credentials'))
				])
			])
		]),
		E('section', { 'class': 'lucky-panel', 'aria-label': _('Core maintenance') }, [
			E('h3', {}, _('Core maintenance')),
			textRow(_('Core file status'), 'lucky-core-health'),
			E('p', { 'class': 'lucky-hint' }, _('Repair missing execution permissions, or upload a trusted Lucky Linux tar.gz release to install or replace the core. Configuration is preserved. Archive limit: 64 MiB.')),
			E('div', { 'class': 'lucky-actions' }, [
				E('button', { 'type': 'button', 'id': 'lucky-core-fix', 'class': 'btn cbi-button', 'click': function() { return coreMaintenance(false); } }, _('Repair execution permissions')),
				E('button', { 'type': 'button', 'id': 'lucky-core-upload', 'class': 'btn cbi-button cbi-button-action', 'click': function() { return coreMaintenance(true); } }, _('Upload core'))
			])
		]),
		E('section', { 'class': 'lucky-panel', 'aria-label': _('Configuration backup and restore') }, [
			E('h3', {}, _('Configuration backup and restore')),
			E('p', { 'class': 'lucky-hint' }, _('Back up every file in the saved configuration directory. Restore replaces the entire directory. Lucky is stopped during the operation and restarted only if it was running.')),
			E('p', { 'class': 'lucky-hint' }, _('Only LuCI full-directory ZIP backups are supported here, not backups exported by the Lucky admin panel. ZIP limit: 64 MiB; up to 10000 entries.')),
			E('p', { 'class': 'lucky-hint' }, _('Restore is allowed only into an empty directory or one containing a regular .lkcf file at its root. You will review the file changes before confirming.')),
			E('div', { 'class': 'lucky-actions' }, [
				E('button', { 'type': 'button', 'id': 'lucky-backup', 'class': 'btn cbi-button cbi-button-action',
					'click': function() { return configurationArchive(false); } }, _('Download backup')),
				E('button', { 'type': 'button', 'id': 'lucky-restore', 'class': 'btn cbi-button cbi-button-negative',
					'click': function() { return configurationArchive(true); } }, _('Restore backup')),
				E('button', { 'type': 'button', 'id': 'lucky-clear', 'class': 'btn cbi-button cbi-button-negative',
					'click': function() { return configurationArchive('clear'); } }, _('Clear configuration'))
			]),
			E('p', { 'id': 'lucky-backup-status', 'class': 'lucky-hint', 'role': 'status', 'aria-live': 'polite' })
		])
	]);

	Array.prototype.forEach.call(dashboard.querySelectorAll('button, input'), function(node) {
		node.disabled = true;
	});
	// Do not hold LuCI's view loader open while starting the Lucky binary.
	window.setTimeout(loadState, 0);
	return dashboard;
}

return view.extend({
	render: function() {
		var map = new form.Map('lucky');
		var section = map.section(form.TypedSection, 'lucky', _('Persistent configuration'));
		section.anonymous = true;
		section.addremove = false;

		var option = section.option(form.Value, 'configdir', _('Configuration directory'));
		option.default = '/etc/config/lucky.daji';
		option.rmempty = false;
		option.validate = function(sectionId, value) {
			if (!value || value.charAt(0) !== '/' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
				return _('The configuration directory must be a safe absolute path.');
			if (value === '/' || /^\/\//.test(value) || /^\/(proc|sys|dev|run)(\/|$)/.test(value) || /\/\.\.?($|\/)/.test(value))
				return _('This configuration directory is not allowed.');
			return true;
		};

		return map.render().then(function(formNode) {
			return E('div', { 'class': 'lucky-page' }, [ renderDashboard(),
				E('div', { 'class': 'lucky-panel lucky-config' }, [ formNode ]) ]);
		});
	}
});

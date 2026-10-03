'use strict';
// SPDX-License-Identifier: Apache-2.0
'require view';
'require form';
'require rpc';
'require ui';

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
var state = {
	installed: false,
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

function helper(args) {
	return callHelper(HELPER, args).then(function(res) {
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
	if (refreshInProgress)
		return Promise.resolve();
	refreshInProgress = true;
	state.loading = true;
	state.error = null;
	state.configReady = false;
	updateDashboard(false);
	function failed(err) {
		state.error = err && err.message ? err.message : _('Unable to load Lucky data.');
		updateDashboard(false);
	}

	return Promise.all([
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
	return E('div', { 'class': 'tr' }, [
		E('div', { 'class': 'td left', 'width': '33%' }, label),
		E('div', { 'class': 'td left', 'id': id }, _('Collecting data…'))
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
	node.className = 'td left lucky-value ' + (css || '');
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
		link.textContent = accessible ? adminURL() : (state.loading ? _('Collecting data…') : _('Available when the service is running'));
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
	setDisabled('lucky-service-stop', !state.installed || !state.runtimeReady || refreshInProgress || !state.running);
}

function updateDashboard(updateInputs) {
	var refresh = document.getElementById('lucky-refresh');
	if (refresh) {
		refresh.disabled = refreshInProgress || resetInProgress;
		refresh.textContent = refreshInProgress ? _('Refreshing…') : _('Refresh');
	}
	updateText('lucky-install', state.error ? _('Load error: %s').format(state.error) : (state.installed ? _('Installed') : (state.loading ? _('Collecting data…') : _('Not installed'))), state.error ? 'error' : (state.installed ? 'success' : ''));
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
	updateRuntimeStatus();
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
	var dashboard = E('div', { 'class': 'cbi-section lucky-dashboard' }, [
		E('style', {}, [
			'.lucky-dashboard .table{max-width:760px}',
			'.lucky-dashboard .td.left{padding:.55rem .75rem}',
			'.lucky-dashboard .lucky-value{font-weight:600}',
			'.lucky-dashboard .success{color:#16803a}',
			'.lucky-dashboard .error{color:#c0392b}',
			'.lucky-dashboard .warning{color:#9a6700}',
			'.lucky-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0 1.25rem}',
			'.lucky-inline{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:.65rem 0}',
			'.lucky-inline label{min-width:12rem}',
			'.lucky-inline input[type="text"],.lucky-inline input[type="number"]{max-width:22rem}',
			'.lucky-admin-link{display:inline-block;margin:.4rem 0 1rem;font-weight:600;overflow-wrap:anywhere}'
		].join('\n')),
		E('h3', {}, _('Service overview')),
		E('div', { 'class': 'table', 'role': 'status', 'aria-live': 'polite' }, [
			textRow(_('Installation status'), 'lucky-install'),
			textRow(_('Running status'), 'lucky-running'),
			textRow(_('Package architecture'), 'lucky-arch'),
			textRow(_('Lucky version'), 'lucky-version'),
			textRow(_('Build date'), 'lucky-date'),
			textRow(_('Admin access policy'), 'lucky-internet')
		]),
		E('div', { 'class': 'lucky-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-reload',
				'id': 'lucky-refresh',
				'type': 'button',
				'click': function() { return loadState(); }
			}, _('Refresh')),
			serviceButton(_('Start'), 'cbi-button-apply', 'start'),
			serviceButton(_('Restart'), 'cbi-button-reload', 'restart'),
			serviceButton(_('Stop'), 'cbi-button-reset', 'stop')
		]),
		E('h3', {}, _('Admin panel')),
		E('a', {
			'class': 'lucky-admin-link',
			'id': 'lucky-admin-link',
			'target': '_blank',
			'rel': 'noopener noreferrer',
			'aria-disabled': 'true',
			'tabindex': '-1'
		}, _('Available when the service is running')),
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
		E('div', { 'class': 'lucky-actions' }, [
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
		var map = new form.Map('lucky', _('Lucky'),
			_('Manage the Lucky service, admin panel access and persistent configuration directory.'));
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
			return E([], [ renderDashboard(), formNode ]);
		});
	}
});

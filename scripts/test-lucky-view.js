// Run with: node scripts/test-lucky-view.js
// Exercise delayed and failed RPC replies without requiring a LuCI installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
	'../luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js'), 'utf8');

function fixture(storage) {
	const nodes = {}, calls = {}, timers = [], archiveCalls = [], notices = [], watchdogCalls = [];
	function E(tag, attrs, children) {
		const node = Object.assign({ tag, textContent: children, disabled: false,
			style: {}, setAttribute(k, v) { this[k] = v; },
			removeAttribute(k) { delete this[k]; },
			querySelectorAll() { return Object.values(nodes).filter(n => /^(button|input)$/.test(n.tag)); }
		}, attrs);
		if (attrs && attrs.id) nodes[attrs.id] = node;
		return node;
	}
	const context = {
		fs: { write: (path, value) => { context.lastWrite = {path, value}; return Promise.resolve(); } },
		E, L: { resource: value => '/luci-static/resources/' + value, env: { cgi_base: '/cgi-bin' } }, _: value => value,
		document: { getElementById: id => nodes[id], querySelectorAll: () => Object.values(nodes).filter(n => /^(button|input)$/.test(n.tag)) },
		window: { localStorage: storage, location: { hostname: 'localhost' }, setTimeout: fn => timers.push(fn), confirm: () => true },
		view: { extend: value => value }, ui: { addNotification: (title, body) => notices.push(body), uploadFile: () => Promise.resolve(), showModal: () => {}, hideModal: () => {} },
		request: { post: (url, body, options) => new Promise((resolve, reject) => {
			assert.equal(options.timeout, 0, 'maintenance must not time out while Lucky is stopped');
			const command = new URLSearchParams(body).get('command').split(' ');
			if (command[1] === 'configure') {
				assert.equal(command.length, 3, 'settings use one CGI argument, including empty/quoted values');
				const args = JSON.parse(decodeURIComponent(command[2]));
				assert.equal(command[0], '/usr/libexec/lucky-backup');
				calls[args[0]] = { args, resolve: response => resolve({status:200, json:() => JSON.parse(response.stdout)}), reject };
				return;
			}
			archiveCalls.push({ operation: command[1], token: command[2], reply: result => resolve({ status: 200, json: () => result }) });
		}) },
		form: { Map: function() {
			context.configMap = this;
			this.save = () => context.saveFailure ? Promise.reject(new Error('UCI save failed')) : Promise.resolve('saved');
			this.section = () => ({ option: () => ({}) });
			this.render = () => Promise.resolve({});
		} },
		rpc: {
			declare(options) {
				assert.equal(options.nobatch, true, 'status must not wait for a batch of slow queries');
				return (command, args) => new Promise((resolve, reject) => {
					if (command === '/usr/libexec/lucky-watchdog') {
						if (args[0] === 'status') {
							if (context.oldCorePackage) { reject(new Error('Not found')); return; }
							resolve({ code: 0, stdout: JSON.stringify(context.watchdogData || {enabled:false,scheduled:false,paused:false,cron_running:true}) });
						} else watchdogCalls.push({ operation:args[0], resolve, reject });
						return;
					}
					if (args[0] === 'core-status') {
						if (context.deferCoreStatus) { calls['core-status'] = { resolve, reject }; return; }
						if (context.coreReply !== undefined) { resolve(context.coreReply); return; }
						resolve({ code: 0, stdout: JSON.stringify({ ok: true, status: context.coreStatus || 'ready', info: context.cachedInfo, base: context.cachedBase, available_memory_kib: context.availableMemory === undefined ? 512 * 1024 : context.availableMemory }) }); return;
					}
					if (/^(core-(info|base)|base-invalidate|set-port|set-safe-url|set-internet|reset-auth)$/.test(args[0]))
						assert.equal(command, '/usr/libexec/lucky-backup', 'cache-sensitive operations must use the locked backend helper');
					assert.ok(!/^(set-port|set-safe-url|set-internet|reset-auth)$/.test(args[0]), 'stop/write/restart must bypass the RPC deadline');
					calls[args[0]] = { resolve, reject };
				});
			},
			getStatusText: () => 'Permission denied', getSessionID: () => 'test-session'
		}
	};
	vm.createContext(context);
	vm.runInContext("String.prototype.format = function(v) { return this.replace('%s', v); };", context);
	const view = vm.runInContext('(function() {\n' + source + '\n})()', context);
	return { view, nodes, calls, timers, archiveCalls, notices, context, watchdogCalls };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = (f, name, value) => f.calls[name].resolve({ code: 0,
	stdout: typeof value === 'string' ? value : JSON.stringify(/^core-(info|base)$/.test(name) ? {ok: true, ...value} : value) });
const watchdog = setTimeout(() => { console.error('FAIL: unresolved RPC in frontend test'); process.exit(1); }, 10000);

(async () => {
	const preferences = new Map();
	const storage = { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) };
	const layout = fixture(storage);
	await layout.view.render();
	assert.equal(layout.nodes['lucky-page']['data-layout'], 'columns');
	assert.equal(layout.nodes['lucky-layout'].disabled, false, 'layout must be usable before service queries finish');
	layout.nodes['lucky-port'].value = '16688';
	layout.nodes['lucky-rules-text-localips'].value = '192.168.1.0/24\n';
	layout.nodes['lucky-tab-rules'].click();
	layout.nodes['lucky-layout'].change({target:{value:'stacked'}});
	assert.equal(layout.nodes['lucky-page']['data-layout'], 'stacked');
	assert.equal(layout.nodes['lucky-tab-panel-rules'].hidden, false, 'layout switching preserves the active tab');
	assert.equal(layout.nodes['lucky-port'].value, '16688');
	assert.equal(layout.nodes['lucky-rules-text-localips'].value, '192.168.1.0/24\n', 'layout switching must preserve unsaved edits');
	assert.deepEqual(Object.keys(layout.calls), [], 'layout preference must not query or write the router');
	assert.equal(layout.timers.length, 1, 'layout switching must not reload the dashboard');
	const reopened = fixture(storage); await reopened.view.render();
	assert.equal(reopened.nodes['lucky-page']['data-layout'], 'stacked', 'remember the choice across page visits');
	reopened.nodes['lucky-layout'].change({target:{value:'columns'}});
	const columns = fixture(storage); await columns.view.render();
	assert.equal(columns.nodes['lucky-page']['data-layout'], 'columns', 'switching back must also persist');
	for (const unavailable of [undefined, {getItem: () => 'invalid'}, {
		getItem: () => { throw new Error('Storage denied'); },
		setItem: () => { throw new Error('Storage full'); }
	}]) {
		const fallback = fixture(unavailable); await fallback.view.render();
		assert.equal(fallback.nodes['lucky-page']['data-layout'], 'columns');
		fallback.nodes['lucky-layout'].change({target:{value:'stacked'}});
		assert.equal(fallback.nodes['lucky-page']['data-layout'], 'stacked', 'blocked storage must not prevent switching');
	}
	console.log('PASS: layout preference persists, preserves tabs and edits, and works without browser storage or RPC');

	const f = fixture();
	await f.view.render();
	const nativeFooter = {};
	f.view.super = method => {
		assert.equal(method, 'addFooter', 'keep native LuCI save/apply handlers');
		return nativeFooter;
	};
	let mountedFooter;
	f.nodes['lucky-config-actions'].appendChild = node => { mountedFooter = node; };
	f.view.addFooter();
	assert.equal(mountedFooter, nativeFooter, 'UCI actions belong to the configuration form in Maintenance');
	assert.deepEqual(Object.keys(f.calls), [], 'render must finish before launching slow queries');
	assert.equal(f.nodes['lucky-port'].disabled, true);
	const loading = f.timers[0]();
	assert.equal(f.calls['core-info'], undefined, 'packed-core queries must not run concurrently');
	reply(f, 'status', 'true');
	reply(f, 'arch', 'x86_64');
	await flush();
	assert.equal(f.nodes['lucky-core-upload'].disabled, true, 'active core query holds the maintenance lock');
	await f.nodes['lucky-core-upload'].click();
	assert.equal(f.archiveCalls.length, 0, 'do not race upload with an active core query');
	assert.equal(f.nodes['lucky-running'].textContent, 'Running');
	assert.equal(f.nodes['lucky-port'].disabled, true);
	assert.equal(f.nodes['lucky-admin-link'].href, undefined);
	reply(f, 'core-base', { BaseConfigure: { AdminWebListenPort: 16601, SafeURL: '/preview' } });
	await flush();
	assert.equal(f.nodes['lucky-port'].disabled, false);
	assert.equal(f.nodes['lucky-admin-link'].href, 'http://localhost:16601/preview');
	assert.equal(f.nodes['lucky-admin-link'].textContent, 'Open admin panel');
	assert.equal(f.nodes['lucky-admin-address'].textContent, 'http://localhost:16601/preview');
	f.nodes['lucky-port'].value = '16688';
	reply(f, 'core-info', { Version: '2.27.2', Date: 'test' });
	await loading;
	assert.equal(f.nodes['lucky-port'].value, '16688', 'late metadata must not overwrite edits');
	assert.equal(f.nodes['lucky-save-port'].disabled, false);
	assert.equal(f.nodes['lucky-version'].textContent, '2.27.2');
	assert.equal(f.nodes['lucky-refresh'].disabled, false);
	assert.equal(f.timers.length, 1, 'only the initial load should be scheduled');
	const refreshed = f.nodes['lucky-refresh'].click();
	assert.equal(f.nodes['lucky-refresh'].disabled, true);
	assert.equal(f.nodes['lucky-refresh'].textContent, 'Refreshing…');
	const pendingStatus = f.calls.status;
	await f.nodes['lucky-refresh'].click();
	assert.equal(f.calls.status, pendingStatus, 'repeated clicks must not launch duplicate queries');
	reply(f, 'status', 'false');
	reply(f, 'arch', 'x86_64');
	await flush();
	reply(f, 'core-base', { BaseConfigure: { AdminWebListenPort: 16602 } });
	await flush();
	reply(f, 'core-info', { Version: '2.27.3' });
	await refreshed;
	assert.equal(f.nodes['lucky-refresh'].textContent, 'Refresh');
	assert.equal(f.nodes['lucky-refresh'].disabled, false);
	assert.equal(f.nodes['lucky-running'].textContent, 'Stopped');
	assert.equal(f.nodes['lucky-admin-link'].href, undefined);
	assert.equal(f.nodes['lucky-admin-link']['aria-disabled'], 'true');
	assert.equal(f.nodes['lucky-admin-address'].textContent, '');
	assert.equal(f.nodes['lucky-port'].value, 16602);
	assert.equal(f.nodes['lucky-version'].textContent, '2.27.3');

	const failed = fixture();
	await failed.view.render();
	const failure = failed.timers[0]();
	await flush();
	reply(failed, 'status', 'true');
	reply(failed, 'arch', 'x86_64');
	failed.calls['core-base'].resolve(6);
	await flush();
	reply(failed, 'core-info', { Version: '2.27.2' });
	await failure;
	assert.equal(failed.nodes['lucky-running'].textContent, 'Running');
	assert.equal(failed.nodes['lucky-port'].disabled, true);
	assert.equal(failed.nodes['lucky-save-port'].disabled, true);
	assert.equal(failed.nodes['lucky-admin-link'].href, undefined);
	assert.match(failed.nodes['lucky-install'].textContent, /Permission denied/);
	assert.equal(failed.nodes['lucky-refresh'].disabled, false, 'allow retry after failure');
	assert.equal(failed.nodes['lucky-core-upload'].disabled, false, 'failed binary query must release upload');

	for (const [response, message] of [
		[6, 'Permission denied'],
		[{ code: 127 }, 'Command failed (exit code 127).'],
		[{ code: 1, stderr: "module 'luci.jsonc' not found" }, "module 'luci.jsonc' not found"],
		[{ code: 0, stdout: '{"ok":false,"error":"Cannot open backup lock"}' }, 'Cannot open backup lock'],
		[{ code: 0, stdout: 'invalid json' }, 'Invalid response from Core status.'],
		[{ code: 0, stdout: '{"ok":true,"status":"unknown"}' }, 'Unable to inspect core.']
	]) {
		const broken = fixture(); broken.context.coreReply = response;
		await broken.view.render(); const loading = broken.timers[0]();
		reply(broken, 'status', 'true'); reply(broken, 'arch', 'arm64'); await loading;
		assert.ok(broken.nodes['lucky-install'].textContent.includes(message), 'keep the original inspection failure');
		assert.equal(broken.calls['core-base'], undefined, 'failed inspection must not launch core queries');
		assert.equal(broken.calls['core-info'], undefined);
		assert.equal(broken.nodes['lucky-core-upload'].disabled, false, 'inspection failure must leave upload available');
		assert.equal(broken.nodes['lucky-running'].textContent, 'Running');
		assert.equal(broken.nodes['lucky-service-stop'].disabled, false);
		assert.equal(broken.nodes['lucky-refresh'].disabled, false);
		broken.context.coreReply = undefined;
		const retry = broken.nodes['lucky-refresh'].click();
		reply(broken, 'status', 'true'); reply(broken, 'arch', 'arm64'); await flush();
		reply(broken, 'core-base', {BaseConfigure:{}}); await flush(); reply(broken, 'core-info', {Version:'3.2.3'}); await retry;
		assert.equal(broken.nodes['lucky-install'].textContent, 'Installed', 'successful retry clears the old error');
		const stale = broken.nodes['lucky-refresh'].click();
		broken.calls.status.reject(new Error('Service RPC unavailable')); reply(broken, 'arch', 'arm64'); await flush();
		reply(broken, 'core-base', {BaseConfigure:{}}); await flush(); reply(broken, 'core-info', {Version:'3.2.3'}); await stale;
		assert.equal(broken.nodes['lucky-running'].textContent, 'Unable to read service status.');
		assert.equal(broken.nodes['lucky-service-stop'].disabled, true, 'failed refresh must not retain a stale running state');
	}
	console.log('PASS: inspection failures retain their cause, skip dependent queries and allow retry; failed status reads clear stale state');

	const restore = f.nodes['lucky-restore'].click();
	assert.equal(f.nodes['lucky-refresh'].disabled, true);
	assert.equal(f.nodes['lucky-service-start'].disabled, true);
	assert.equal(f.nodes['lucky-port'].disabled, true);
	const token = 'a'.repeat(32);
	f.archiveCalls[0].reply({ ok: true, token });
	await flush();
	assert.equal(f.archiveCalls[1].operation, 'check');
	f.archiveCalls[1].reply({ ok: false, error: 'Corrupt ZIP' });
	await flush();
	assert.equal(f.archiveCalls[2].operation, 'cleanup');
	f.archiveCalls[2].reply({ ok: true });
	await flush();
	reply(f, 'status', 'false'); reply(f, 'arch', 'x86_64');
	reply(f, 'core-base', { BaseConfigure: { AdminWebListenPort: 16602 } }); await flush(); reply(f, 'core-info', { Version: '2.27.3' });
	await restore;
	assert.equal(f.nodes['lucky-restore'].disabled, false);
	assert.equal(f.nodes['lucky-service-start'].disabled, false);
	assert.equal(f.nodes['lucky-port'].disabled, false);
	assert.equal(f.archiveCalls.some(call => call.operation === 'restore'), false, 'invalid archive must not reach restore');
	assert.equal(f.notices[0].textContent, 'Corrupt ZIP');
	for (const confirm of [false, true]) {
		let modal;
		f.context.ui.showModal = (title, children) => { modal = { title, children }; };
		let i = f.archiveCalls.length;
		const clearing = f.nodes['lucky-clear'].click();
		f.archiveCalls[i++].reply({ ok: true, token });
		await flush();
		assert.equal(f.archiveCalls[i].operation, 'clear-check');
		f.archiveCalls[i++].reply({ ok: true, directory: '/etc/config/lucky.daji', removed: ['old.lkcf', '.hidden'], replaced: [], added: [] });
		await flush();
		assert.equal(modal.title, 'Clear configuration');
		assert.equal(f.archiveCalls.length, i, 'no deletion before explicit confirmation');
		const buttons = modal.children.at(-1).textContent;
		buttons[confirm ? 2 : 0].click();
		await flush();
		if (confirm) {
			assert.equal(f.archiveCalls[i].operation, 'clear');
			f.archiveCalls[i++].reply({ ok: true });
			await flush();
		}
		assert.equal(f.archiveCalls[i].operation, 'cleanup');
		f.archiveCalls[i].reply({ ok: true });
		await flush();
		reply(f, 'status', 'false'); reply(f, 'arch', 'x86_64');
		reply(f, 'core-base', { BaseConfigure: { AdminWebListenPort: 16602 } }); await flush(); reply(f, 'core-info', { Version: '2.27.3' });
		await clearing;
		assert.equal(f.nodes['lucky-clear'].disabled, false);
	}
	console.log('PASS: clear requires file-list confirmation; cancel never deletes; confirmed clear calls backend');
	for (const health of ['missing', 'permissions', 'unsafe']) {
		const unavailable = fixture(); unavailable.context.coreStatus = health;
		await unavailable.view.render();
		const loading = unavailable.timers[0](); await flush();
		assert.equal(unavailable.nodes['lucky-core-upload'].disabled, false, health + ': slow status reads must not block upload');
		assert.equal(unavailable.calls['core-base'], undefined, 'do not query an unavailable core');
		assert.equal(unavailable.calls['core-info'], undefined);
		reply(unavailable, 'status', 'false'); reply(unavailable, 'arch', 'x86_64'); await loading;
		assert.equal(unavailable.nodes['lucky-core-upload'].disabled, false);
	}
	const missing = fixture(); missing.context.coreStatus = 'missing';
	await missing.view.render();
	assert.equal(missing.nodes['lucky-core-upload'].disabled, false, 'upload is available before initial inspection');
	const missingLoad = missing.timers[0]();
	reply(missing, 'status', 'false'); reply(missing, 'arch', 'x86_64'); await missingLoad;
	assert.equal(missing.nodes['lucky-core-upload'].disabled, false, 'missing core must not block upload');
	assert.equal(missing.nodes['lucky-core-fix'].disabled, true);
	assert.equal(missing.nodes['lucky-core-health'].textContent, 'Core missing');
	let j = missing.archiveCalls.length;
	const uploadCore = missing.nodes['lucky-core-upload'].click();
	assert.equal(missing.archiveCalls[j].operation, 'core-prepare');
	missing.archiveCalls[j++].reply({ ok: true, token }); await flush();
	assert.equal(missing.archiveCalls[j].operation, 'core-check');
	missing.archiveCalls[j++].reply({ ok: false, error: 'Wrong architecture' }); await flush();
	assert.equal(missing.archiveCalls[j].operation, 'cleanup');
	missing.archiveCalls[j].reply({ ok: true }); await flush();
	reply(missing, 'status', 'false'); reply(missing, 'arch', 'x86_64'); await uploadCore;
	assert.equal(missing.archiveCalls.some(c => c.operation === 'core-install'), false);
	console.log('PASS: missing core allows upload; invalid core never reaches replacement');
	for (const lateHealth of ['ready', 'missing', 'error']) {
		const repair = fixture(); repair.context.deferCoreStatus = true;
		await repair.view.render();
		const stalledLoad = repair.timers[0](); await flush();
		const oldCalls = { ...repair.calls };
		assert.equal(repair.nodes['lucky-core-upload'].disabled, false, 'stalled inspection must not block repair');
		let modal;
		repair.context.ui.showModal = (title, children) => { modal = { title, children }; };
		const uploading = repair.nodes['lucky-core-upload'].click();
		let i = 0;
		assert.equal(repair.archiveCalls[i].operation, 'core-prepare');
		assert.equal(repair.nodes['lucky-core-upload'].disabled, true, 'prevent duplicate maintenance');
		await repair.nodes['lucky-core-upload'].click();
		assert.equal(repair.archiveCalls.length, 1);
		repair.archiveCalls[i++].reply({ ok: true, token }); await flush();
		assert.equal(repair.archiveCalls[i].operation, 'core-check');
		repair.archiveCalls[i++].reply({ ok: true, bytes: 24000000 }); await flush();
		assert.equal(modal.title, 'Replace core');
		modal.children.at(-1).textContent[2].click(); await flush();
		assert.equal(repair.archiveCalls[i].operation, 'core-install');
		repair.archiveCalls[i++].reply({ ok: true, version: '3.3.3', date: 'repaired', running: false }); await flush();
		repair.context.deferCoreStatus = false;
		repair.context.cachedInfo = { Version: '3.3.3', Date: 'repaired' };
		repair.context.cachedBase = { BaseConfigure: { AdminWebListenPort: 16601 } };
		assert.equal(repair.archiveCalls[i].operation, 'cleanup');
		repair.archiveCalls[i].reply({ ok: true }); await flush();
		reply(repair, 'status', 'false'); reply(repair, 'arch', 'x86_64'); await uploading;
		assert.equal(repair.nodes['lucky-core-health'].textContent, 'Executable');
		assert.equal(repair.nodes['lucky-version'].textContent, '3.3.3');
		if (lateHealth === 'error') oldCalls['core-status'].reject(new Error('Old inspection failed'));
		else oldCalls['core-status'].resolve({ code: 0, stdout: JSON.stringify({
			ok: true, status: lateHealth, info: { Version: 'old' },
			base: { BaseConfigure: { AdminWebListenPort: 19999 } }, available_memory_kib: 512 * 1024
		}) });
		oldCalls.status.resolve({ code: 0, stdout: 'true' });
		oldCalls.arch.resolve({ code: 0, stdout: 'old-arch' });
		await stalledLoad;
		assert.equal(repair.nodes['lucky-core-health'].textContent, 'Executable', 'late inspection must not undo repair');
		assert.equal(repair.nodes['lucky-version'].textContent, '3.3.3');
		assert.equal(repair.nodes['lucky-install'].textContent, 'Installed');
		assert.equal(repair.nodes['lucky-running'].textContent, 'Stopped');
		assert.equal(repair.nodes['lucky-arch'].textContent, 'x86_64');
		assert.equal(repair.nodes['lucky-port'].value, 16601);
		assert.equal(repair.calls['core-base'], undefined, 'abandoned refresh must never launch the new core');
		assert.equal(repair.calls['core-info'], undefined);
		assert.equal(repair.nodes['lucky-core-upload'].disabled, false);
	}
	console.log('PASS: upload repairs undetectable cores while status is pending; late replies cannot overwrite repaired state');
	for (const confirm of [false, true]) {
		let modal;
		f.context.ui.showModal = (title, children) => { modal = { title, children }; };
		let i = f.archiveCalls.length;
		const previousInfo = f.calls['core-info'], previousBase = f.calls['core-base'];
		const upgrade = f.nodes['lucky-core-upload'].click();
		f.archiveCalls[i++].reply({ ok: true, token }); await flush();
		assert.equal(f.archiveCalls[i].operation, 'core-check');
		f.archiveCalls[i++].reply({ ok: true, bytes: 24000000 }); await flush();
		assert.equal(modal.title, 'Replace core');
		assert.equal(f.archiveCalls.length, i, 'no stop/install before confirmation');
		assert.match(modal.children[1].textContent, /stop before running the new core/);
		modal.children.at(-1).textContent[confirm ? 2 : 0].click(); await flush();
		if (confirm) {
			assert.equal(f.archiveCalls[i].operation, 'core-install');
			f.archiveCalls[i++].reply({ ok: true, version: '3.2.1', running: false }); await flush();
			assert.match(f.notices.at(-1).textContent, /3.2.1.*Service remains stopped/);
		}
		assert.equal(f.archiveCalls[i].operation, 'cleanup');
		f.archiveCalls[i].reply({ ok: true }); await flush();
		reply(f, 'status', 'false'); reply(f, 'arch', 'x86_64');
		await upgrade;
		assert.equal(f.calls['core-info'], previousInfo, 'must not spawn metadata query alongside restarted service');
		assert.equal(f.calls['core-base'], previousBase, 'must not spawn configuration query alongside restarted service');
		if (confirm) {
			assert.equal(f.nodes['lucky-version'].textContent, '3.2.1', 'keep metadata validated during installation');
			assert.equal(f.nodes['lucky-install'].textContent, 'Installed');
			assert.equal(f.nodes['lucky-service-start'].disabled, false);
		}
	}
	console.log('PASS: static preview requires explicit stop confirmation; cancel only cleans up; success shows actual state');
	for (const repaired of [false, true]) {
		const repair = fixture(); repair.context.coreStatus = 'permissions'; repair.context.availableMemory = 0;
		await repair.view.render(); const initial = repair.timers[0]();
		reply(repair, 'status', 'false'); reply(repair, 'arch', 'arm64'); await initial;
		assert.equal(repair.nodes['lucky-core-fix'].disabled, false);
		const task = repair.nodes['lucky-core-fix'].click(); await flush();
		assert.equal(repair.archiveCalls[0].operation, 'core-fix');
		repair.context.coreStatus = repaired ? 'ready' : 'permissions';
		repair.archiveCalls[0].reply(repaired ? {ok:true,status:'ready'} : {ok:false,error:'Read-only filesystem'});
		await flush(); reply(repair, 'status', 'false'); await task;
		assert.equal(repair.nodes['lucky-install'].textContent, repaired ? 'Installed' : 'Execution permission missing');
		assert.equal(repair.nodes['lucky-core-health'].textContent, repaired ? 'Executable' : 'Execution permission missing');
		assert.equal(repair.nodes['lucky-service-start'].disabled, !repaired, 'successful repair must enable starting the core');
		assert.equal(repair.nodes['lucky-core-fix'].disabled, repaired);
		assert.equal(repair.nodes['lucky-version'].textContent, '-', 'repair does not fabricate core metadata');
		assert.equal(repair.nodes['lucky-admin-link'].href, undefined);
		assert.equal(repair.calls['core-info'], undefined);
		assert.equal(repair.calls['core-base'], undefined);
		if (!repaired) assert.match(repair.notices[0].textContent, /Read-only filesystem/);
	}
	for (const ending of ['missing', 'permissions', 'unsafe', 'core-failed', 'status-failed', 'config-cleared', 'core-changed']) {
		const changed = fixture();
		changed.context.cachedInfo = {Version:'3.2.3',Date:'cached-build'};
		changed.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old'}};
		await changed.view.render(); const initial = changed.timers[0]();
		reply(changed, 'status', 'true'); reply(changed, 'arch', 'arm64'); await initial;
		assert.equal(changed.nodes['lucky-admin-link'].href, 'http://localhost:16601/old');
		changed.context.ui.uploadFile = () => Promise.reject(new Error('Upload cancelled'));
		const task = changed.nodes['lucky-core-upload'].click();
		changed.archiveCalls[0].reply({ok:true,token}); await flush();
		assert.equal(changed.archiveCalls[1].operation, 'cleanup');
		if (ending === 'core-failed') changed.context.coreReply = 6;
		else if (ending === 'config-cleared') changed.context.cachedBase = undefined;
		else if (ending === 'core-changed') {
			changed.context.cachedBase = undefined; changed.context.cachedInfo = undefined;
		}
		else if (ending !== 'status-failed') changed.context.coreStatus = ending;
		changed.archiveCalls[1].reply({ok:true}); await flush();
		assert.equal(changed.nodes['lucky-admin-link'].href, undefined, 'do not retain a stale entry while the fast check is pending');
		assert.equal(changed.nodes['lucky-refresh'].disabled, true, 'wait for both fast checks even when one fails');
		if (ending === 'status-failed') changed.calls.status.reject(new Error('Service RPC unavailable'));
		else reply(changed, 'status', 'true');
		await task;
		assert.equal(changed.nodes['lucky-admin-link'].href, undefined, 'failed/missing core checks must not leave an active old entry');
		assert.equal(changed.nodes['lucky-service-start'].disabled, true);
		assert.equal(changed.nodes['lucky-service-restart'].disabled, !['config-cleared', 'core-changed'].includes(ending));
		assert.equal(changed.nodes['lucky-service-stop'].disabled, ending === 'status-failed', 'a known running process can still be stopped');
		assert.equal(changed.nodes['lucky-port'].disabled, ending !== 'status-failed');
		assert.equal(changed.nodes['lucky-version'].textContent, ['status-failed', 'config-cleared'].includes(ending) ? '3.2.3' : '-');
		assert.equal(changed.nodes['lucky-date'].textContent, ['status-failed', 'config-cleared'].includes(ending) ? 'cached-build' : '-');
		if (ending !== 'status-failed') {
			assert.equal(changed.nodes['lucky-port'].value, '', 'unavailable configuration must not show stale editable values');
			assert.equal(changed.nodes['lucky-safe-url'].value, '');
		}
		assert.equal(changed.calls['core-info'], undefined);
		assert.equal(changed.calls['core-base'], undefined, 'maintenance recovery only uses non-executing status checks');
		assert.equal(changed.nodes['lucky-refresh'].disabled, false);
		if (ending === 'core-failed') assert.match(changed.nodes['lucky-install'].textContent, /Permission denied/);
		if (ending === 'status-failed') assert.equal(changed.nodes['lucky-running'].textContent, 'Unable to read service status.');
	}
	for (const scenario of ['empty-form', 'changed-cache', 'port-edited', 'safe-url-edited', 'internet-edited']) {
		const refreshed = fixture();
		refreshed.context.cachedInfo = {Version:'3.2.3',Date:'cached-build'};
		refreshed.context.availableMemory = 0;
		if (scenario !== 'empty-form')
			refreshed.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old',AllowInternetaccess:false}};
		await refreshed.view.render(); const initial = refreshed.timers[0]();
		reply(refreshed, 'status', 'true'); reply(refreshed, 'arch', 'arm64'); await initial;
		if (scenario === 'empty-form') {
			assert.equal(refreshed.nodes['lucky-port'].value, '');
			assert.equal(refreshed.nodes['lucky-port'].disabled, true);
		}
		if (scenario === 'port-edited') refreshed.nodes['lucky-port'].value = '16655';
		if (scenario === 'safe-url-edited') refreshed.nodes['lucky-safe-url'].value = '/unsaved';
		if (scenario === 'internet-edited') refreshed.nodes['lucky-allow-internet'].checked = true;
		refreshed.context.ui.uploadFile = () => Promise.reject(new Error('Upload cancelled'));
		const task = refreshed.nodes['lucky-core-upload'].click();
		refreshed.archiveCalls[0].reply({ok:true,token}); await flush();
		refreshed.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16609,SafeURL:'/new',AllowInternetaccess:scenario !== 'internet-edited'}};
		refreshed.archiveCalls[1].reply({ok:true}); await flush();
		reply(refreshed, 'status', 'true'); await task;
		assert.equal(refreshed.nodes['lucky-port'].value, scenario === 'port-edited' ? '16655' : 16609, 'refresh untouched or previously unavailable fields');
		assert.equal(refreshed.nodes['lucky-safe-url'].value, scenario === 'safe-url-edited' ? '/unsaved' : '/new');
		assert.equal(refreshed.nodes['lucky-allow-internet'].checked, true, 'preserve an edited checkbox while syncing an untouched checkbox');
		assert.equal(refreshed.nodes['lucky-admin-link'].href, 'http://localhost:16609/new', 'the admin entry follows saved configuration, not unsaved inputs');
		for (const id of ['lucky-port', 'lucky-safe-url', 'lucky-allow-internet']) assert.equal(refreshed.nodes[id].disabled, false);
		assert.equal(refreshed.calls['core-info'], undefined);
		assert.equal(refreshed.calls['core-base'], undefined, 'synchronizing cached form values must not execute the core');
	}
	console.log('PASS: maintenance synchronizes repaired/missing cores, drops stale entries on fast-check failures and never launches metadata queries');
	f.nodes['lucky-tab-rules'].click();
	assert.equal(f.nodes['lucky-tab-panel-overview'].hidden, true);
	assert.equal(f.nodes['lucky-tab-panel-rules'].hidden, false);
	assert.equal(missing.nodes['lucky-rules-load-allowlist'].disabled, true);
	let r = f.archiveCalls.length;
	const reading = f.nodes['lucky-rules-load-localips'].click(); await flush();
	assert.equal(f.archiveCalls[r].operation, 'rules-localips');
	f.archiveCalls[r++].reply({ok:true, token, directory:'/etc/lucky', name:'localips', content:'10.0.0.0/8\n'});
	await reading;
	f.nodes['lucky-rules-text-localips'].value = '192.168.0.0/16\n';
	f.nodes['lucky-rules-text-localips'].input();
	f.nodes['lucky-tab-overview'].click(); f.nodes['lucky-tab-rules'].click();
	assert.equal(f.nodes['lucky-rules-text-localips'].value, '192.168.0.0/16\n');
	const saving = f.nodes['lucky-rules-save-localips'].click(); await flush();
	assert.equal(JSON.parse(f.context.lastWrite.value).content, '192.168.0.0/16\n');
	assert.equal(f.archiveCalls[r].operation, 'rules-save');
	f.archiveCalls[r++].reply({ok:true}); await flush();
	assert.equal(f.archiveCalls[r].operation, 'cleanup'); f.archiveCalls[r].reply({ok:true}); await saving;
	assert.equal(f.nodes['lucky-rules-save-localips'].disabled, true);
	console.log('PASS: accessible tabs preserve edits; version gate and staged rules save work');
	assert.equal(f.calls.read, undefined, 'diagnostics must not run on initial load, refresh or maintenance');
	assert.equal(f.nodes['lucky-diagnostics-refresh'].disabled, false);
	f.nodes['lucky-diagnostics'].open = true;
	const diagnostics = f.nodes['lucky-diagnostics'].toggle();
	assert.equal(f.nodes['lucky-diagnostics-refresh'].disabled, true);
	const pendingLogs = f.calls.read;
	await f.nodes['lucky-diagnostics-refresh'].click();
	assert.equal(f.calls.read, pendingLogs, 'duplicate reads must coalesce');
	reply(f, 'read', {sources:[{name:'logread',status:'ok'},{name:'dmesg',status:'failed'}],
		events:[{source:'logread',kind:'crash',text:'panic: <script>alert(1)</script>'}]});
	await diagnostics;
	assert.match(f.nodes['lucky-diagnostics-text'].value, /panic: <script>/, 'logs remain plain textarea text');
	assert.match(f.nodes['lucky-diagnostics-text'].value, /Read failed or permission denied/);
	assert.equal(f.nodes['lucky-diagnostics-copy'].disabled, false);
	f.nodes['lucky-diagnostics'].open = false; f.nodes['lucky-diagnostics'].toggle();
	f.nodes['lucky-diagnostics'].open = true; f.nodes['lucky-diagnostics'].toggle();
	assert.equal(f.calls.read, pendingLogs, 'reopening must reuse the displayed snapshot');
	let selected = false;
	f.nodes['lucky-diagnostics-text'].focus = () => {};
	f.nodes['lucky-diagnostics-text'].select = () => { selected = true; };
	f.context.document.execCommand = () => false;
	f.nodes['lucky-diagnostics-copy'].click();
	assert.equal(selected, true, 'HTTP browsers need a manual copy fallback');
	assert.match(f.nodes['lucky-diagnostics-status'].textContent, /Use your browser copy command/);
	const logFailure = f.nodes['lucky-diagnostics-refresh'].click();
	f.calls.read.reject(new Error('Permission denied')); await logFailure;
	assert.equal(f.nodes['lucky-diagnostics-text'].value, '', 'clear stale excerpts after failure');
	assert.equal(f.nodes['lucky-diagnostics-copy'].disabled, true);
	assert.equal(f.nodes['lucky-diagnostics-refresh'].disabled, false);
	const logRetry = f.nodes['lucky-diagnostics-refresh'].click();
	reply(f, 'read', {sources:[{name:'logread',status:'ok'}],events:{}}); await logRetry;
	assert.match(f.nodes['lucky-diagnostics-text'].value, /No matching records found/);
	assert.equal(f.timers.length, 1, 'logs must not add periodic timers');
	console.log('PASS: diagnostics load lazily, coalesce reads, preserve plain text, support HTTP copying and retry failures');
	console.log('PASS: nonblocking render, independent status, safe controls, preserved edits, RPC failure');
	console.log('PASS: maintenance disables edits, rejects invalid ZIP before restore and cleans up uploads');
	console.log('PASS: packed-core queries run sequentially, including recovery after a failed configuration query');
	const cached = fixture();
	cached.context.cachedInfo = {Version: '3.2.3', Date: 'cached-build'};
	await cached.view.render(); const cachedLoad = cached.timers[0]();
	reply(cached, 'status', 'true'); reply(cached, 'arch', 'x86_64'); await flush();
	assert.equal(cached.nodes['lucky-version'].textContent, '3.2.3', 'cached info must not wait for the configuration query');
	assert.equal(cached.calls['core-info'], undefined, 'cache hit must not launch a version query');
	reply(cached, 'core-base', {BaseConfigure:{AdminWebListenPort:16601}}); await cachedLoad;
	const cachedRefresh = cached.nodes['lucky-refresh'].click();
	reply(cached, 'status', 'true'); reply(cached, 'arch', 'x86_64'); await flush();
	reply(cached, 'core-base', {BaseConfigure:{AdminWebListenPort:16602}}); await cachedRefresh;
	assert.equal(cached.calls['core-info'], undefined, 'manual refresh should also reuse a valid cache');
	assert.equal(cached.nodes['lucky-port'].value, 16602, 'configuration is still queried live');
	cached.context.cachedInfo = undefined;
	const changedCore = cached.nodes['lucky-refresh'].click();
	reply(cached, 'status', 'true'); reply(cached, 'arch', 'x86_64'); await flush();
	assert.equal(cached.calls['core-info'], undefined, 'cache miss must still serialize core execution');
	reply(cached, 'core-base', {BaseConfigure:{}}); await flush();
	reply(cached, 'core-info', {Version:'3.2.4'}); await changedCore;
	assert.equal(cached.nodes['lucky-version'].textContent, '3.2.4', 'a changed core must replace the displayed metadata');
	const errorInfo = fixture(); await errorInfo.view.render(); const badInfoLoad = errorInfo.timers[0]();
	reply(errorInfo, 'status', 'true'); reply(errorInfo, 'arch', 'x86_64'); await flush();
	reply(errorInfo, 'core-base', {BaseConfigure:{}}); await flush();
	reply(errorInfo, 'core-info', {ok:false,error:'Core changed during version query'}); await badInfoLoad;
	assert.equal(errorInfo.nodes['lucky-version'].textContent, '-');
	assert.match(errorInfo.nodes['lucky-install'].textContent, /Core changed during version query/);
	console.log('PASS: cached versions appear immediately and survive refresh; cache misses serialize and report backend errors');
	for (const [version, online] of [
		['2.27.2', false], ['3.3.99', false], ['3.4.0', true],
		['v3.4.0', true], ['3.10.0', true], ['4.0.0', true], ['3.4.0-beta', false], ['dev', false]
	]) {
		const versioned = fixture();
		versioned.context.cachedInfo = {Version:version};
		versioned.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601}};
		await versioned.view.render(); const loading = versioned.timers[0]();
		reply(versioned, 'status', 'true'); reply(versioned, 'arch', 'x86_64'); await loading;
		assert.equal(versioned.nodes['lucky-access-hint'].textContent.includes('without restarting'), online, version);
	}
	const both = fixture();
	both.context.cachedInfo = {Version:'3.2.3', Date:'cached-build'};
	both.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16603,SafeURL:'/cached',AllowInternetaccess:true}};
	both.context.availableMemory = 0;
	await both.view.render(); const warmLoad = both.timers[0]();
	reply(both, 'status', 'true'); reply(both, 'arch', 'arm64'); await warmLoad;
	assert.equal(both.calls['core-info'], undefined);
	assert.equal(both.calls['core-base'], undefined, 'both valid caches avoid any core query, even under memory pressure');
	assert.equal(both.nodes['lucky-admin-link'].href, 'http://localhost:16603/cached');
	const warmRefresh = both.nodes['lucky-refresh'].click();
	reply(both, 'status', 'false'); reply(both, 'arch', 'arm64'); await warmRefresh;
	assert.equal(both.calls['core-base'], undefined);
	assert.equal(both.nodes['lucky-running'].textContent, 'Stopped', 'runtime status must remain live on cache hits');
	both.context.cachedBase = undefined; both.context.availableMemory = 512 * 1024;
	const configChanged = both.nodes['lucky-refresh'].click();
	reply(both, 'status', 'true'); reply(both, 'arch', 'arm64'); await flush();
	reply(both, 'core-base', {BaseConfigure:{AdminWebListenPort:16604,SafeURL:'/changed'}}); await configChanged;
	assert.equal(both.nodes['lucky-admin-link'].href, 'http://localhost:16604/changed');
	assert.equal(both.calls['core-info'], undefined, 'changed config must not invalidate an unchanged core version');
	const badBase = both.nodes['lucky-refresh'].click();
	reply(both, 'status', 'true'); reply(both, 'arch', 'arm64'); await flush();
	reply(both, 'core-base', {ok:false,error:'Invalid Lucky base configuration response'}); await badBase;
	assert.equal(both.nodes['lucky-admin-link'].href, undefined, 'base query errors must not expose stale admin URLs');
	assert.equal(both.nodes['lucky-port'].disabled, true);
	assert.equal(both.nodes['lucky-port'].value, '');
	assert.equal(both.nodes['lucky-safe-url'].value, '');
	console.log('PASS: both caches skip core queries; live status, changed config and base query errors stay correct');
	for (const policy of [undefined, false, true]) {
		const edit = fixture();
		edit.context.cachedInfo = {Version:'3.3.3',Date:'cached'};
		edit.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old',AllowInternetaccess:policy}};
		await edit.view.render(); const initial = edit.timers[0]();
		reply(edit, 'status', 'true'); reply(edit, 'arch', 'arm64'); await initial;
		assert.equal(edit.nodes['lucky-internet'].textContent,
			policy === undefined ? 'Not reported by this core' : (policy ? 'Allowed' : 'Local access only'));
		assert.equal(edit.nodes['lucky-allow-internet'].indeterminate, policy === undefined);
		assert.equal(edit.nodes['lucky-allow-internet'].checked, policy === true);
	}
	for (const [operation, button] of [
		['set-port', 'lucky-save-port'], ['set-safe-url', 'lucky-save-safe-url'],
		['set-internet', 'lucky-save-internet'], ['reset-auth', 'lucky-reset-auth']
	]) {
		const edit = fixture();
		edit.context.cachedInfo = {Version:'3.2.3',Date:'cached'};
		edit.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old'}};
		await edit.view.render(); const initial = edit.timers[0]();
		reply(edit, 'status', 'true'); reply(edit, 'arch', 'arm64'); await initial;
		edit.nodes['lucky-port'].value = '16602'; edit.nodes['lucky-safe-url'].value = '/new';
		edit.nodes[button].click(); await flush();
		assert.ok(edit.calls[operation]);
		if (operation !== 'reset-auth') {
			for (const id of ['lucky-save-safe-url', 'lucky-save-port', 'lucky-service-start',
				'lucky-service-stop', 'lucky-service-restart', 'lucky-refresh'])
				assert.equal(edit.nodes[id].disabled, true, id + ' must wait for the save transaction');
			assert.equal(edit.nodes['lucky-admin-link'].href, undefined, 'hide the old entry during a save');
			const pending = edit.calls[operation];
			edit.nodes[button].click(); await flush();
			assert.equal(edit.calls[operation], pending, 'ignore duplicate saves');
		}
		edit.context.cachedBase = undefined;
		const output = operation === 'reset-auth' ? JSON.stringify({account:'admin',password:'a'.repeat(24),restarted:true}) : '';
		reply(edit, operation, {ok:true,stdout:output}); await flush();
		reply(edit, 'status', 'true'); reply(edit, 'arch', 'arm64');
		reply(edit, 'core-base', {BaseConfigure:{AdminWebListenPort:16602,SafeURL:'/normalized'}}); await flush();
		assert.equal(edit.nodes['lucky-admin-link'].href, 'http://localhost:16602/normalized');
		assert.equal(edit.nodes['lucky-safe-url'].value, '/normalized', 'show the entry the core actually saved');
		assert.equal(edit.calls['core-info'], undefined, 'setting writes must retain the version cache');
	}
	for (const restarted of [false, true]) {
		const reset = fixture();
		reset.context.cachedInfo = {Version:'3.3.3',Date:'cached'};
		reset.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old'}};
		await reset.view.render(); const initial = reset.timers[0]();
		reply(reset, 'status', 'true'); reply(reset, 'arch', 'arm64'); await initial;
		let modal;
		reset.context.ui.showModal = (title, children) => { modal = {title, children}; };
		reset.nodes['lucky-reset-auth'].click();
		reply(reset, 'reset-auth', {
			ok:true, stdout:JSON.stringify({account:'admin',password:'a'.repeat(24),restarted}),
			warning:'Lucky could not restart; start it manually'
		}); await flush();
		assert.equal(modal.title, 'Admin credentials reset', 'a recovery warning must not discard the changed credentials');
		assert.match(JSON.stringify(modal.children), /a{24}/);
		assert.match(JSON.stringify(modal.children), /Restart it manually after saving this password/);
		reply(reset, 'status', 'false'); reply(reset, 'arch', 'arm64'); await flush();
		assert.equal(reset.nodes['lucky-admin-link'].href, undefined);
	}
	for (const result of [{ok:false,error:'write failed'}, {ok:true,stdout:'saved',warning:'Lucky could not restart'}]) {
		const edit = fixture();
		edit.context.cachedInfo = {Version:'3.3.3',Date:'cached'};
		edit.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old'}};
		await edit.view.render(); const initial = edit.timers[0]();
		reply(edit, 'status', 'true'); reply(edit, 'arch', 'arm64'); await initial;
		edit.nodes['lucky-safe-url'].value = '/new'; edit.nodes['lucky-save-safe-url'].click();
		reply(edit, 'set-safe-url', result); await flush();
		assert.equal(edit.notices.length, 1, 'do not report success when saving or restarting fails');
		reply(edit, 'status', 'false'); reply(edit, 'arch', 'arm64'); await flush();
		assert.equal(edit.nodes['lucky-running'].textContent, 'Stopped', 'refresh state after failures too');
		assert.equal(edit.nodes['lucky-save-safe-url'].disabled, false, 'allow retry');
		assert.equal(edit.nodes['lucky-admin-link'].href, undefined);
	}
	const directorySave = fixture(); await directorySave.view.render();
	const saved = directorySave.context.configMap.save(); await flush();
	assert.ok(directorySave.calls['base-invalidate'], 'native UCI save explicitly invalidates base cache');
	reply(directorySave, 'base-invalidate', {ok:true}); assert.equal(await saved, 'saved');
	delete directorySave.calls['base-invalidate']; directorySave.context.saveFailure = true;
	await assert.rejects(directorySave.context.configMap.save(), /UCI save failed/);
	assert.equal(directorySave.calls['base-invalidate'], undefined, 'failed UCI save must retain its original error');
	console.log('PASS: setting writes use backend invalidation and refresh data; native UCI save clears only the base cache');
	for (const value of ['', "/entry'quoted", '/路径%25\\value']) {
		const encoded = fixture();
		encoded.context.cachedInfo = {Version:'3.3.3',Date:'cached'};
		encoded.context.cachedBase = {BaseConfigure:{AdminWebListenPort:16601,SafeURL:'/old'}};
		await encoded.view.render(); const initial = encoded.timers[0]();
		reply(encoded, 'status', 'true'); reply(encoded, 'arch', 'arm64'); await initial;
		encoded.nodes['lucky-safe-url'].value = value;
		encoded.nodes['lucky-save-safe-url'].click();
		assert.deepEqual(Array.from(encoded.calls['set-safe-url'].args), ['set-safe-url', value]);
		reply(encoded, 'set-safe-url', {ok:true,stdout:'saved'}); await flush();
		reply(encoded, 'status', 'true'); reply(encoded, 'arch', 'arm64'); await flush();
	}
	for (const info of [{Version:'3.2.3',Date:'cached-build'}, null, {Version:''}]) {
		const low = fixture(); low.context.availableMemory = 0; low.context.cachedInfo = info;
		await low.view.render(); const loading = low.timers[0]();
		reply(low, 'status', 'true'); reply(low, 'arch', 'x86_64'); await loading;
		assert.equal(low.calls['core-base'], undefined);
		assert.equal(low.calls['core-info'], undefined, 'a missing/invalid cache must not bypass low-memory protection');
		assert.equal(low.nodes['lucky-version'].textContent, info && info.Version ? '3.2.3' : '-');
	}
	console.log('PASS: low-memory devices display validated cached metadata without executing Lucky');
	for (const available of [0, 128 * 1024 - 1, null]) {
		const low = fixture(); low.context.availableMemory = available;
		await low.view.render(); const loading = low.timers[0]();
		const running = available !== 0;
		reply(low, 'status', String(running)); reply(low, 'arch', 'x86_64'); await loading;
		assert.equal(low.calls['core-base'], undefined, 'low/unknown memory must not start a packed core');
		assert.equal(low.calls['core-info'], undefined);
		assert.equal(low.nodes['lucky-running'].textContent, running ? 'Running' : 'Stopped');
		assert.equal(low.nodes['lucky-service-start'].disabled, running, 'a skipped query must not block starting a stopped core');
		assert.equal(low.nodes['lucky-backup'].disabled, false, 'backup must remain available without querying the binary');
		assert.match(low.nodes['lucky-install'].textContent, /Not enough available memory/);
		assert.equal(low.nodes['lucky-refresh'].disabled, false);
		assert.equal(low.nodes['lucky-diagnostics-refresh'].disabled, false);
		const logs = low.nodes['lucky-diagnostics-refresh'].click();
		reply(low, 'read', {sources:[{name:'logread',status:'ok'}],events:[]}); await logs;
		assert.match(low.nodes['lucky-diagnostics-text'].value, /No matching records/);
	}
	console.log('PASS: low-memory protection skips core execution while status and diagnostics remain usable');
	const w = fixture(); w.context.availableMemory = 0;
	await w.view.render();
	const wl = w.timers[0](); reply(w, 'status', 'false'); reply(w, 'arch', 'x86_64'); await wl;
	assert.equal(w.nodes['lucky-watchdog-toggle']['aria-checked'], 'false');
	const on = w.nodes['lucky-watchdog-toggle'].click();
	assert.equal(w.watchdogCalls[0].operation, 'enable');
	assert.equal(w.nodes['lucky-watchdog-toggle'].disabled, true);
	await w.nodes['lucky-watchdog-toggle'].click();
	assert.equal(w.watchdogCalls.length, 1, 'duplicate toggle must not race the crontab update');
	w.context.watchdogData = {enabled:true,scheduled:true,paused:true,cron_running:true};
	w.watchdogCalls[0].resolve({code:0, stdout:JSON.stringify(w.context.watchdogData)}); await on;
	assert.equal(w.nodes['lucky-watchdog-toggle']['aria-checked'], 'true');
	assert.match(w.nodes['lucky-watchdog-status'].textContent, /Paused after stopping/);
	assert.equal(w.calls.service, undefined, 'enabling recovery must never start a manually stopped service');
	const off = w.nodes['lucky-watchdog-toggle'].click();
	assert.equal(w.watchdogCalls[1].operation, 'disable');
	w.watchdogCalls[1].reject(new Error('Read-only filesystem')); await off;
	assert.equal(w.nodes['lucky-watchdog-toggle']['aria-checked'], 'true', 'failed toggle must reload the actual state');
	w.context.oldCorePackage = true;
	const old = w.nodes['lucky-refresh'].click(); reply(w, 'status', 'false'); reply(w, 'arch', 'x86_64'); await old;
	assert.equal(w.nodes['lucky-watchdog-toggle'].disabled, true);
	assert.match(w.nodes['lucky-watchdog-status'].textContent, /updated Lucky core package/);
	assert.equal(w.nodes['lucky-service-start'].disabled, false, 'old service packages must retain normal controls');
	console.log('PASS: recovery toggle does not start Lucky; duplicate clicks, failed writes and old core packages handled');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));

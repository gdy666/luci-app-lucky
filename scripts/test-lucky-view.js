// Run with: node scripts/test-lucky-view.js
// Exercise delayed and failed RPC replies without requiring a LuCI installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
	'../luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js'), 'utf8');

function fixture() {
	const nodes = {}, calls = {}, timers = [], archiveCalls = [], notices = [];
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
		E, L: { resource: value => '/luci-static/resources/' + value, env: { cgi_base: '/cgi-bin' } }, _: value => value,
		document: { getElementById: id => nodes[id], querySelectorAll: () => Object.values(nodes).filter(n => /^(button|input)$/.test(n.tag)) },
		window: { location: { hostname: 'localhost' }, setTimeout: fn => timers.push(fn), confirm: () => true },
		view: { extend: value => value }, ui: { addNotification: (title, body) => notices.push(body), uploadFile: () => Promise.resolve(), showModal: () => {}, hideModal: () => {} },
		request: { post: (url, body, options) => new Promise(resolve => {
			assert.equal(options.timeout, 0, 'maintenance must not time out while Lucky is stopped');
			const command = new URLSearchParams(body).get('command').split(' ');
			archiveCalls.push({ operation: command[1], token: command[2], reply: result => resolve({ status: 200, json: () => result }) });
		}) },
		form: { Map: function() {
			this.section = () => ({ option: () => ({}) });
			this.render = () => Promise.resolve({});
		} },
		rpc: {
			declare(options) {
				assert.equal(options.nobatch, true, 'status must not wait for a batch of slow queries');
				return (command, args) => new Promise((resolve, reject) => {
					if (args[0] === 'core-status') { resolve({ code: 0, stdout: JSON.stringify({ ok: true, status: context.coreStatus || 'ready' }) }); return; }
					calls[args[0]] = { resolve, reject };
				});
			},
			getStatusText: () => 'Permission denied', getSessionID: () => 'test-session'
		}
	};
	vm.createContext(context);
	vm.runInContext("String.prototype.format = function(v) { return this.replace('%s', v); };", context);
	const view = vm.runInContext('(function() {\n' + source + '\n})()', context);
	return { view, nodes, calls, timers, archiveCalls, notices, context };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = (f, name, value) => f.calls[name].resolve({ code: 0,
	stdout: typeof value === 'string' ? value : JSON.stringify(value) });

(async () => {
	const f = fixture();
	await f.view.render();
	assert.deepEqual(Object.keys(f.calls), [], 'render must finish before launching slow queries');
	assert.equal(f.nodes['lucky-port'].disabled, true);
	const loading = f.timers[0]();
	reply(f, 'status', 'true');
	reply(f, 'arch', 'x86_64');
	await flush();
	assert.equal(f.nodes['lucky-running'].textContent, 'Running');
	assert.equal(f.nodes['lucky-port'].disabled, true);
	assert.equal(f.nodes['lucky-admin-link'].href, undefined);
	reply(f, 'base', { BaseConfigure: { AdminWebListenPort: 16601, SafeURL: '/preview' } });
	await flush();
	assert.equal(f.nodes['lucky-port'].disabled, false);
	assert.equal(f.nodes['lucky-admin-link'].href, 'http://localhost:16601/preview');
	assert.equal(f.nodes['lucky-admin-link'].textContent, 'Open admin panel');
	assert.equal(f.nodes['lucky-admin-address'].textContent, 'http://localhost:16601/preview');
	f.nodes['lucky-port'].value = '16688';
	reply(f, 'info', { Version: '2.27.2', Date: 'test' });
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
	reply(f, 'base', { BaseConfigure: { AdminWebListenPort: 16602 } });
	reply(f, 'info', { Version: '2.27.3' });
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
	reply(failed, 'status', 'true');
	reply(failed, 'arch', 'x86_64');
	reply(failed, 'info', { Version: '2.27.2' });
	failed.calls.base.resolve(6);
	await failure;
	assert.equal(failed.nodes['lucky-running'].textContent, 'Running');
	assert.equal(failed.nodes['lucky-port'].disabled, true);
	assert.equal(failed.nodes['lucky-save-port'].disabled, true);
	assert.equal(failed.nodes['lucky-admin-link'].href, undefined);
	assert.match(failed.nodes['lucky-install'].textContent, /Permission denied/);
	assert.equal(failed.nodes['lucky-refresh'].disabled, false, 'allow retry after failure');

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
	reply(f, 'base', { BaseConfigure: { AdminWebListenPort: 16602 } }); reply(f, 'info', { Version: '2.27.3' });
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
		reply(f, 'base', { BaseConfigure: { AdminWebListenPort: 16602 } }); reply(f, 'info', { Version: '2.27.3' });
		await clearing;
		assert.equal(f.nodes['lucky-clear'].disabled, false);
	}
	console.log('PASS: clear requires file-list confirmation; cancel never deletes; confirmed clear calls backend');
	const missing = fixture(); missing.context.coreStatus = 'missing';
	await missing.view.render();
	const missingLoad = missing.timers[0]();
	missing.calls.info.resolve({ code: 127, stderr: 'Lucky is not installed' });
	missing.calls.base.resolve({ code: 127, stderr: 'Lucky is not installed' });
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
	missing.calls.info.resolve({ code: 127 }); missing.calls.base.resolve({ code: 127 });
	reply(missing, 'status', 'false'); reply(missing, 'arch', 'x86_64'); await uploadCore;
	assert.equal(missing.archiveCalls.some(c => c.operation === 'core-install'), false);
	console.log('PASS: missing core allows upload; invalid core never reaches replacement');
	console.log('PASS: nonblocking render, independent status, safe controls, preserved edits, RPC failure');
	console.log('PASS: maintenance disables edits, rejects invalid ZIP before restore and cleans up uploads');
})().catch(err => { console.error(err); process.exitCode = 1; });

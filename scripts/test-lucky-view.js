// Run with: node scripts/test-lucky-view.js
// Exercise delayed and failed RPC replies without requiring a LuCI installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
	'../luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js'), 'utf8');

function fixture() {
	const nodes = {}, calls = {}, timers = [];
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
		E, L: { resource: value => '/luci-static/resources/' + value }, _: value => value, document: { getElementById: id => nodes[id] },
		window: { location: { hostname: 'localhost' }, setTimeout: fn => timers.push(fn) },
		view: { extend: value => value }, ui: {},
		form: { Map: function() {
			this.section = () => ({ option: () => ({}) });
			this.render = () => Promise.resolve({});
		} },
		rpc: {
			declare(options) {
				assert.equal(options.nobatch, true, 'status must not wait for a batch of slow queries');
				return (command, args) => new Promise((resolve, reject) => {
					calls[args[0]] = { resolve, reject };
				});
			},
			getStatusText: () => 'Permission denied'
		}
	};
	vm.createContext(context);
	vm.runInContext("String.prototype.format = function(v) { return this.replace('%s', v); };", context);
	const view = vm.runInContext('(function() {\n' + source + '\n})()', context);
	return { view, nodes, calls, timers };
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
	console.log('PASS: nonblocking render, independent status, safe controls, preserved edits, RPC failure');
})().catch(err => { console.error(err); process.exitCode = 1; });

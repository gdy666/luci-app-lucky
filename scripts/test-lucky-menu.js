// Run with node. No browser or router state is changed by these checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'luci-app-lucky/htdocs/luci-static/lucky-menu-refresh.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function visit(saved, options = {}) {
	let stored = saved, redirect = null, href;
	const status = {};
	const context = {
		window: {
			location: { pathname: options.pathname || '/proxy/router/luci-static/lucky-menu-refresh.html', search: '?redirect=https://example.invalid/', replace: url => { redirect = url; } },
			sessionStorage: {
				getItem: key => { assert.equal(key, 'luci-session-store'); if (options.blocked) throw new Error('blocked'); return stored; },
				setItem: (key, value) => { assert.equal(key, 'luci-session-store'); stored = value; }
			}
		},
		document: { getElementById: id => id === 'status' ? status : { setAttribute: (name, value) => { assert.equal(name, 'href'); href = value; } } }
	};
	vm.runInNewContext(script, context);
	return { stored, redirect, href, status };
}

const original = { sid1: { menu: { stale: true }, token: 'keep', tab: { active: 2 }, rpcBaseURL: '/ubus' }, sid2: { menu: {}, keep: 42 }, unrelated: 'keep' };
const expected = structuredClone(original);
delete expected.sid1.menu; delete expected.sid2.menu;
const result = visit(JSON.stringify(original));
assert.deepEqual(JSON.parse(result.stored), expected);
assert.equal(result.redirect, '/proxy/router/cgi-bin/luci/admin/services/lucky');
assert.equal(result.href, result.redirect);
assert.equal(visit(null, { pathname: '//external.invalid/luci-static/lucky-menu-refresh.html' }).redirect, '/external.invalid/cgi-bin/luci/admin/services/lucky');
assert.equal(visit(null).redirect, result.redirect, 'old Lua LuCI without client cache still opens Lucky');
assert.equal(visit('broken').stored, 'broken', 'malformed data must not be deleted');
assert.equal(visit('broken').redirect, null);
assert.equal(visit(JSON.stringify(original), { blocked: true }).redirect, null);
console.log('PASS: refresh link preserves session data, handles unavailable storage and keeps redirects same-origin');

const source = fs.readFileSync(path.join(root, 'luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js'), 'utf8');
assert.ok(source.includes("'require session';"), 'LuCI exposes session as a required module, not L.session');
const fn = source.slice(source.indexOf('function refreshCachedMenu()'), source.indexOf('function helper('));
let menu = { children: { admin: { children: {} } } }, reloads = 0, writable = true, attempted = null;
const context = {
	session: {
		getLocalData: key => key === 'menu' ? menu : attempted,
		setLocalData: (key, value) => { assert.equal(key, 'luckyMenuRefresh'); if (!writable) return false; attempted = value; return true; }
	},
	ui: { menu: { flushCache: () => { if (writable) menu = null; } } },
	window: { location: { reload: () => { reloads++; } } }
};
vm.createContext(context); vm.runInContext(fn, context);
assert.equal(context.refreshCachedMenu(), true);
assert.equal(context.refreshCachedMenu(), false, 'cleared cache must not reload twice');
assert.equal(reloads, 1);
menu = { children: { admin: { children: {} } } };
assert.equal(context.refreshCachedMenu(), false, 'a fresh server menu still missing Lucky must not loop');
menu = { children: { admin: { children: { services: { children: { lucky: { title: 'Lucky', satisfied: true } } } } } } };
assert.equal(context.refreshCachedMenu(), false);
assert.equal(attempted, null, 'a visible menu allows recovery after a later reinstall');
menu.children.admin.children.services.children.lucky.satisfied = false;
assert.equal(context.refreshCachedMenu(), true, 'a cached unsatisfied dependency also needs refresh');
menu = {}; writable = false;
assert.equal(context.refreshCachedMenu(), false, 'failed storage writes must not cause reload loops');
delete context.session;
assert.equal(context.refreshCachedMenu(), false, 'legacy adapter has no native session API');
assert.equal(reloads, 2);
console.log('PASS: direct Lucky visit repairs stale menus once and leaves legacy LuCI and current menus alone');

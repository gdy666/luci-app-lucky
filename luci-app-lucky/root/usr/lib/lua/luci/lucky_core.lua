-- SPDX-License-Identifier: Apache-2.0
local fs, n, json = require "nixio.fs", require "nixio", require "luci.jsonc"
local M, BIN = {}, "/usr/bin/lucky"
local LIMIT = 128 * 1024 * 1024
local function must(v, msg) if not v then error(msg, 0) end return v end
local function quote(v) return "'" .. v:gsub("'", "'\\''") .. "'" end
local function read(path, limit)
 local f = must(io.open(path, "rb"), "Cannot read core file")
 local s = f:read(limit or "*a"); f:close(); return s
end
local function write(path, data)
 local f = must(io.open(path, "wb"), "Cannot write core workspace")
 must(f:write(data), "Cannot write core workspace"); must(f:close(), "Cannot close core workspace")
end
local function safe_target()
 for _, path in ipairs({ "/usr", "/usr/bin" }) do
  local s = fs.lstat(path); must(s and s.type == "dir" and s.uid == 0, "Unsafe core parent directory")
 end
 local s = fs.lstat(BIN)
 must(not s or (s.type == "reg" and s.nlink == 1), "Core must be a regular file, not a link")
 return s
end
local function elf(path)
 local s = must(read(path, 64), "Empty core file")
 must(#s >= 52 and s:sub(1, 4) == "\127ELF" and (s:byte(5) == 1 or s:byte(5) == 2), "Core is not a Linux ELF executable")
 local host = read("/bin/busybox", 64)
 must(s:sub(5, 6) == host:sub(5, 6) and s:sub(19, 20) == host:sub(19, 20), "Core architecture does not match this system")
 local kind = s:byte(6) == 1 and s:byte(17) or s:byte(18)
 must(kind == 2 or kind == 3, "Core ELF is not executable")
end
-- Old OpenWrt has no timeout applet. Bound child runtime and output ourselves.
local function execute(command, output, work, seconds, blocks)
 local pid = must(n.fork(), "Cannot start core validation")
 if pid == 0 then
  n.setsid()
  n.exec("/bin/sh", "-c", "umask 077; ulimit -c 0; ulimit -f " .. blocks .. "; cd " .. quote(work) .. " && exec " .. command .. " >" .. quote(output) .. " 2>/dev/null")
  os.exit(127)
 end
 for _ = 1, seconds * 10 do
  local done, state, code = n.waitpid(pid, "nohang")
  if done == pid then return state == "exited" and code == 0 end
  n.nanosleep(0, 100000000)
 end
 n.kill(-pid, 9); n.kill(pid, 9); n.waitpid(pid)
 return false
end
local function digest(path)
 local f = must(io.open(path, "rb"), "Cannot read core fingerprint")
 local crc, size = 0, 0
 while true do local b = f:read(65536); if not b then break end; crc = n.bin.crc32(b, crc); size = size + #b end
 f:close(); return tostring(size) .. ":" .. tostring(crc)
end
local function name(s)
 s = s:gsub("%z.*$", "")
 while s:sub(1, 2) == "./" do s = s:sub(3) end
 must(s ~= "" and not s:find("[%z\1-\31\127\\:]") and s:sub(1, 1) ~= "/", "Unsafe archive path")
 for part in s:gmatch("[^/]+") do must(part ~= "." and part ~= "..", "Unsafe archive path") end
 return s
end
local function oct(s)
 s = s:gsub("%z.*$", ""):match("^%s*(.-)%s*$")
 must(s == "" or s:match("^[0-7]+$"), "Unsupported tar number")
 return s == "" and 0 or tonumber(s, 8)
end
local function unpack_core(work)
 local input, tar, output = work .. "/core.tar.gz", work .. "/core.tar", work .. "/candidate"
 local st = fs.lstat(input)
 must(st and st.type == "reg" and st.nlink == 1 and st.size <= 64 * 1024 * 1024, "Upload must be a tar.gz file no larger than 64 MiB")
 local gz = must(io.open(input, "rb"), "Cannot read gzip size")
 gz:seek("end", -4); local tail = gz:read(4); gz:close()
 must(tail and #tail == 4, "Truncated gzip archive")
 local expanded = tail:byte(1) + tail:byte(2) * 256 + tail:byte(3) * 65536 + tail:byte(4) * 16777216
 must(expanded >= 1024 and expanded <= LIMIT, "Expanded archive must be no larger than 128 MiB")
 local free = must(fs.statvfs(work), "Cannot check workspace space")
 must(free.bavail * free.frsize >= expanded * 2 + 1048576, "Not enough temporary space to validate core")
 must(execute("/bin/busybox gzip -dc " .. quote(input), tar, work, 60, math.ceil(expanded / 512)), "Invalid, oversized or damaged gzip archive")
 must(fs.stat(tar).size == expanded, "Gzip size mismatch or concatenated archives")
 must(fs.unlink(input), "Cannot release uploaded archive")
 local f = must(io.open(tar, "rb"), "Cannot read tar archive")
 local out, found, entries, pending = nil, false, 0, nil
 local ok, err = pcall(function()
  while true do
   local h = f:read(512)
   must(h and #h == 512, "Truncated tar archive")
   if h == string.rep("\0", 512) then
    must(f:read(512) == h, "Incomplete tar end marker")
    while true do local b = f:read(65536); if not b then break end; must(not b:find("[^%z]"), "Unexpected data after tar archive") end
    must(not pending, "Orphan tar metadata"); break
   end
   entries = entries + 1; must(entries <= 1000, "Too many tar entries")
   local sum = 256
   for i = 1, 512 do if i < 149 or i > 156 then sum = sum + h:byte(i) end end
   must(oct(h:sub(149, 156)) == sum, "Tar header checksum mismatch")
   local file = h:sub(1, 100):gsub("%z.*$", "")
   local prefix = h:sub(346, 500):gsub("%z.*$", "")
   if prefix ~= "" then file = prefix .. "/" .. file end
   file = name(file)
   local size, kind = oct(h:sub(125, 136)), h:sub(157, 157)
   must(size <= LIMIT, "Tar entry too large")
   if kind == "x" then
    must(not pending and size <= 65536, "Unsupported tar metadata")
    local data = f:read(size); must(data and #data == size, "Truncated tar metadata")
    pending = {}
    local offset = 1
    while offset <= #data do
     local len = tonumber(data:sub(offset):match("^(%d+) "))
     must(len and len > 3 and offset + len - 1 <= #data, "Invalid PAX metadata")
     local record = data:sub(offset, offset + len - 1)
     local k, v = record:match("^%d+ ([^=]+)=(.*)\n$")
     must(k and k ~= "size" and k ~= "linkpath", "Unsupported PAX metadata")
     if k == "path" then pending.path = name(v) end
     offset = offset + len
    end
   else
    if pending then file = pending.path or file; pending = nil end
    must(kind == "0" or kind == "\0" or kind == "5", "Links and special tar entries are not supported")
    if kind == "5" then must(size == 0, "Invalid tar directory") end
    if file == "lucky" then
     must(not found and kind ~= "5" and size >= 52, "Archive must contain one regular lucky executable at its root")
     found = true; out = must(io.open(output, "wb"), "Cannot extract core")
    end
    local remaining = size
    while remaining > 0 do
     local b = f:read(math.min(65536, remaining)); must(b and #b > 0, "Truncated tar entry")
     if out then must(out:write(b), "Cannot write core (disk full)") end
     remaining = remaining - #b
    end
    if out then must(out:close(), "Cannot close extracted core"); out = nil end
   end
   local padding = (512 - size % 512) % 512
   must(padding == 0 or #(f:read(padding) or "") == padding, "Truncated tar padding")
  end
  must(found, "No root lucky executable found in archive")
 end)
 if out then out:close() end
 f:close(); fs.unlink(tar)
 must(ok, err)
 elf(output); must(fs.chmod(output, "700"), "Cannot make candidate executable")
 return output
end
local function probe(path, work)
 -- Packed executables may write their unpacked image to a memfd. RLIMIT_FSIZE
 -- limits those internal writes too; cap only stdout, through a bounded pipe.
 local input, output = n.pipe()
 must(input and output, "Cannot create core validation pipe")
 if not input:setblocking(false) then input:close(); output:close(); error("Cannot configure core validation pipe", 0) end
 local pid = n.fork()
 if not pid then input:close(); output:close(); error("Cannot start core validation", 0) end
 if pid == 0 then
  input:close(); n.setsid()
  if not n.dup(output, n.stdout) then os.exit(127) end
  output:close()
  n.exec("/bin/sh", "-c", "umask 077; ulimit -c 0; cd " .. quote(work) .. " && exec " .. quote(path) .. " -info </dev/null 2>/dev/null")
  os.exit(127)
 end
 output:close()
 local data, reaped, state, code = "", false, nil, nil
 local ok, err = pcall(function()
  for _ = 1, 150 do
   while true do
    local chunk, why = input:read(4096)
    if not chunk then must(why == 11 or why == 4, "Cannot read core version response"); break end
    if #chunk == 0 then break end
    must(#data + #chunk <= 16384, "Core version response exceeds 16 KiB")
    data = data .. chunk
   end
   if reaped then
    must(state == "exited" and code == 0, "Core version query failed (" .. tostring(state) .. ": " .. tostring(code) .. ")")
    return
   end
   local done
   done, state, code = n.waitpid(pid, "nohang")
   reaped = done == pid
   if not reaped then n.nanosleep(0, 100000000) end
  end
  error("Core version query timed out", 0)
 end)
 input:close()
 if not reaped then n.kill(-pid, 9); n.kill(pid, 9); n.waitpid(pid) end
 must(ok, err)
 local info = json.parse(data)
 must(type(info) == "table" and type(info.Version) == "string" and #info.Version > 0 and #info.Version <= 100, "Not a supported Lucky core (-info failed)")
 return info.Version, type(info.Date) == "string" and info.Date:sub(1, 100) or "-"
end
function M.status()
 local st = fs.lstat(BIN)
 local status = not st and "missing" or (st.type ~= "reg" and "unsafe" or (fs.access(BIN, "x") and "ready" or "permissions"))
 return { status = status, path = BIN }
end
function M.version(work)
 -- Avoid launching another packed core under memory pressure just to enable an editor.
 local mem = read("/proc/meminfo")
 local available = tonumber(mem:match("MemAvailable:%s*(%d+)"))
 if not available then available = (tonumber(mem:match("MemFree:%s*(%d+)")) or 0) end
 must(available >= 192 * 1024, "Not enough available memory to check core version; stop Lucky and retry")
 return probe(BIN, work), digest(BIN)
end
function M.fingerprint() return digest(BIN) end
function M.fix()
 must(safe_target(), "Core is missing; upload a Lucky tar.gz package first")
 elf(BIN); must(fs.chmod(BIN, "755"), "Cannot repair permissions (read-only filesystem?)")
 must(fs.access(BIN, "x"), "Core is still not executable; check filesystem mount permissions")
 return M.status()
end
function M.check(work)
 fs.unlink(work .. "/core-preview")
 safe_target()
 local candidate = unpack_core(work)
 write(work .. "/core-preview", digest(candidate))
 -- Do not execute the candidate while the old service is still running.
 return { bytes = fs.stat(candidate).size, path = BIN }
end
function M.install(work, token, stop, start, running)
 local candidate = work .. "/candidate"
 local st = fs.lstat(candidate)
 must(st and st.type == "reg" and st.nlink == 1, "Check the core archive first")
 must(read(work .. "/core-preview") == digest(candidate), "Core changed; upload and check again")
 elf(candidate); local version, date
 local original = safe_target()
 local free = must(fs.statvfs("/usr/bin"), "Cannot check core disk space")
 must(free.bavail * free.frsize >= st.size + 1048576, "Not enough space to replace core")
 local staged, old = "/usr/bin/.lucky-new-" .. token, "/usr/bin/.lucky-old-" .. token
 must(not fs.lstat(staged) and not fs.lstat(old), "Core staging path already exists")
 local resumed, moved, installed = false, false, false
 local ok, err = pcall(function()
  local src = must(io.open(candidate, "rb"), "Cannot read candidate")
  local dst = io.open(staged, "wb")
  if not dst then src:close(); error("Cannot stage core", 0) end
  local copied, why = pcall(function()
   while true do local b = src:read(65536); if not b then break end; must(dst:write(b), "Cannot stage core (disk full)") end
  end)
  src:close(); local closed = dst:close(); must(copied and closed, why or "Cannot finish core write")
  must(digest(staged) == digest(candidate) and fs.chmod(staged, "755"), "Staged core validation failed")
  resumed = stop()
  safe_target(); must(not running(), "Lucky was started concurrently; replacement cancelled")
  -- One bounded probe, after stopping the old service, on the destination FS.
  version, date = probe(staged, work)
  must(not running(), "Lucky was started concurrently; replacement cancelled")
  if original then must(fs.rename(BIN, old), "Cannot preserve old core"); moved = true end
  must(fs.rename(staged, BIN), "Cannot install new core"); installed = true
  if resumed then must(start(), "New core failed to start") end
 end)
 if not ok then
  if installed then stop() end
  local rolled = not moved or fs.rename(old, BIN)
  if not original and installed then fs.unlink(BIN) end
  fs.unlink(staged)
  if resumed and rolled and original then
   must(start(), tostring(err) .. "; previous core retained but failed to restart; start it manually")
  end
  must(rolled, "Core rollback failed; previous core retained at " .. old)
  error(err, 0)
 end
 local cleaned = not moved or fs.unlink(old)
 return { version = version, date = date, running = resumed, warning = not cleaned and ("Previous core remains at " .. old) or nil }
end
return M

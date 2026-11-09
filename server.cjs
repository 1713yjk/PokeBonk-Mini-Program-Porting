#!/usr/bin/env node
/**
 * 本地静态服务器 —— PokéBonk 网页版（游戏文件平铺在根目录）
 *  - 静态文件 + HTTP Range/HEAD 支持（Unity/WASM 游戏分片、gta io_worker 都需要）
 *  - POST /data/batch：模拟 gta.deloskiyt.pl 的分片聚合端点（body: [[path,start,end],...]，响应拼接 + X-Run-Lengths）
 *  - 用法：node server.cjs [端口]   默认 8080，启动脚本传 8090
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const ROOT = __dirname;
const PORT = parseInt(process.argv[2] || "8080", 10);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".data": "application/octet-stream", ".bin": "application/octet-stream",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".xml": "text/xml", ".csv": "text/csv",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
};

const CROSS = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

// pokebonk 不带 COOP/COEP：它的登录验证是 Cloudflare Turnstile（跨域 script + iframe），
// COEP require-corp 会把 Turnstile 资源拦死导致永远拿不到 captcha token（403）。
// three.js 的 WebGL 不需要跨域隔离（那是 SharedArrayBuffer 才需要，GTA 那类才要）。
const CROSS_LIGHT = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
// 本仓库根目录即游戏根目录，全部请求走 light 头（不带 COOP/COEP）。
const lightHeaders = (p) => CROSS_LIGHT;

function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...(res.H || CROSS), ...headers });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) return send(res, 403, "Forbidden");
  const H = res.H || CROSS;
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not Found: " + p);
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    const range = req.headers.range;
    if (req.method === "HEAD") return send(res, 200, "", { ...base, "Content-Length": st.size });
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start >= st.size) return send(res, 416, "", { ...base, "Content-Range": `bytes */${st.size}` });
        end = Math.min(end, st.size - 1);
        res.writeHead(206, { ...H, ...base, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { ...H, ...base, "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// gta /data/batch 模拟：body JSON [[path, start, end], ...] -> 拼接字节流 + X-Run-Lengths
function serveBatch(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let runs;
    try { runs = JSON.parse(body); } catch { return send(res, 400, "bad json"); }
    const parts = []; const lens = [];
    for (const [p, a, b] of runs) {
      const file = path.join(ROOT, "data", path.normalize(p).replace(/^([/\\])+/, ""));
      try {
        const fd = fs.openSync(file, "r");
        const len = Math.max(0, Math.min(b, fs.fstatSync(fd).size - 1) - a + 1);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, a);
        fs.closeSync(fd);
        parts.push(buf); lens.push(len);
      } catch { parts.push(Buffer.alloc(0)); lens.push(0); }
    }
    send(res, 200, Buffer.concat(parts), { "Content-Type": "application/octet-stream", "X-Run-Lengths": lens.join(",") });
  });
}

// PokéBonk 后端同源代理：客户端把 API 基地址改成 /api-proxy（同源），由本服务器转发到
// https://api.pokebonk.com。浏览器只与 localhost 同源通信，规避官方 API 仅放行 pokebonk.com
// 源的 CORS 限制；服务端 fetch 不受跨域约束。
// ── 本地兜底 ────────────────────────────────────────────────────────────────
// 官方 API 维护或持续 5xx 时，克隆不应该变成一堵「维护中」墙。这里用本地合成账号
// 让启动链路（status → auth → profile → runs）走通：对局以 offline ticket（id 为空）
// 运行，不写官方存档；官方恢复后 PB_MAINT 变回 false，自动回到真实接口。
let PB_STATUS = null;   // 最近一次成功的 /status（用于沿用赛季/活动信息）
let PB_MAINT = false;   // 官方是否处于维护

async function probePokebonkStatus() {
  try {
    const r = await fetch("https://api.pokebonk.com/status", {
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return;
    const j = await r.json();
    PB_STATUS = j;
    PB_MAINT = !!(j.maintenance && j.maintenance.on === true);
  } catch { /* 探测失败保持上一次状态 */ }
}
probePokebonkStatus();
const pbProbe = setInterval(probePokebonkStatus, 20000);
if (pbProbe.unref) pbProbe.unref();

const LOCAL_PROFILES = new Map(); // 本地账号：key -> {name, created, starter}

function localProfileFor(key, starter) {
  let p = LOCAL_PROFILES.get(key);
  if (!p) { p = { name: "本地训练家", created: Date.now(), starter: 7 }; LOCAL_PROFILES.set(key, p); }
  if (starter) p.starter = starter;
  // GD() 会补默认值，这里只给必要字段
  return {
    v: 1, name: p.name, created: p.created,
    stardust: 0, totalStardust: 0, bonk: 0, totalBonk: 0,
    unlocked: [p.starter], league: [p.starter], starter: p.starter,
    forms: [], research: {}, captured: {}, seen: [], played: [], shinies: [],
    classics: [], skins: [], team: [], lab: {}, biomes: { forest: 0 },
    quests: {}, counters: {}, runs: [], best: {}, times: {}, kills: {},
    medals: {}, endless: {}, settings: {},
    lastSpecies: p.starter, lastBiome: "forest",
  };
}

function jsonRes(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": b.length,
  });
  res.end(b);
}

// 返回 true = 已用本地数据应答；false = 交回上游逻辑
function localFallback(req, res, path, body) {
  const auth = String(req.headers["authorization"] || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const device = String(req.headers["x-device"] || "");
  const isLocalToken = token.startsWith("local.");
  const key = isLocalToken ? token.slice(6) : device || "local-device";
  const m = req.method;

  // 维护期：任何账号都用本地档案，避免真实 token 卡在 /profile
  const fakeProfile = isLocalToken || PB_MAINT;

  if (path === "/status" && m === "GET") {
    const st = PB_STATUS
      ? JSON.parse(JSON.stringify(PB_STATUS))
      : { season: { n: 2, name: "", start: Date.now(), end: Date.now() + 86400000, live: true, dust: 1, message: "", next: null }, events: [] };
    st.maintenance = { on: false, title: "", message: "", eta: 0 };
    st.bypass = false;
    jsonRes(res, 200, st);
    return true;
  }
  if (path === "/auth/guest" && m === "POST") {
    // 走到这里说明上游此时不可用：把维护态钉住，后续请求继续用本地档案，
    // 避免本地 token 打到上游拿 401（会被客户端当成会话过期）。
    PB_MAINT = true;
    jsonRes(res, 200, { id: "local-" + key.slice(0, 8), name: "本地训练家", token: "local." + key });
    return true;
  }
  if (path === "/auth/me" && m === "GET" && fakeProfile) {
    jsonRes(res, 200, { id: "local-" + key.slice(0, 8), name: "本地训练家", guest: true });
    return true;
  }
  if (!fakeProfile) return false;

  if (path === "/profile" && m === "GET") { jsonRes(res, 200, { profile: localProfileFor(key) }); return true; }
  if (path === "/profile/starter" && m === "POST") {
    let id = 0;
    try { id = JSON.parse(body || "{}").id || 0; } catch {}
    jsonRes(res, 200, { profile: localProfileFor(key, id || undefined) });
    return true;
  }
  if (path === "/profile/prefs" && m === "PUT") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  if (path === "/runs" && m === "POST") {
    // id 为空 = 客户端按离线对局处理，不写官方存档
    jsonRes(res, 200, { id: "", seed: (Math.random() * 1e9) | 0, ranked: false, boosts: [] });
    return true;
  }
  if (/^\/runs\/[^/]+\/(checkpoint|finish)$/.test(path)) { jsonRes(res, 200, { profile: localProfileFor(key) }); return true; }
  return false;
}

async function serveProxy(req, res, u) {
  const target = "https://api.pokebonk.com" + u.pathname.slice("/api-proxy".length) + u.search;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["host", "origin", "connection", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "accept-encoding"].includes(lk)) continue;
    headers[k] = v;
  }
  // 强制上游返回未压缩明文：浏览器带 Accept-Encoding: gzip,br 时官方 API 会压缩响应，
  // 而 undici 在显式传入 accept-encoding 时不自动解压，直接把 gzip 字节当 JSON 转发会解析失败，
  // 触发客户端 "No connection"。这里改成 identity，拿到的就是可解析的 JSON。
  headers["accept-encoding"] = "identity";
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
  }
  const apiPath = u.pathname.slice("/api-proxy".length);
  // 维护中直接本地应答，省掉每个请求等上游超时的几十秒
  if (PB_MAINT && localFallback(req, res, apiPath, body)) return;
  try {
    // 上游抖动（5xx）重试：GET 幂等可安全重试；/auth/guest 建号失败重试不会产生业务副作用；
    // /runs 由客户端带幂等 key，同一 key 重试不会生成两局。其余 POST 不重试，避免重复结算。
    const retriable =
      req.method === "GET" ||
      req.method === "HEAD" ||
      u.pathname.endsWith("/auth/guest") ||
      (req.method === "POST" && u.pathname === "/api-proxy/runs");
    const maxAttempts = retriable ? 3 : 1;
    let r = null, lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        r = await fetch(target, { method: req.method, headers, body, redirect: "follow", signal: AbortSignal.timeout(45000) });
        if (r.status < 500 || attempt === maxAttempts) break;
        try { await r.arrayBuffer(); } catch {} // 读掉响应体，避免连接泄漏
        await new Promise((s) => setTimeout(s, 500 * attempt + Math.random() * 300));
      } catch (e) {
        lastErr = e;
        r = null;
        if (attempt === maxAttempts) break;
        await new Promise((s) => setTimeout(s, 500 * attempt));
      }
    }
    if (!r) throw lastErr || new Error("upstream unavailable");
    const buf = Buffer.from(await r.arrayBuffer());
    // /status 就地判定：即使后台探测还没跑完，也绝不把「维护中」透给首屏
    if (apiPath === "/status" && r.status < 500) {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        if (j && j.maintenance) {
          PB_STATUS = j;
          PB_MAINT = j.maintenance.on === true;
        }
      } catch { /* 非 JSON 就按原样转发 */ }
      if (PB_MAINT) return localFallback(req, res, apiPath, body);
    }
    // 上游 5xx：先看能否本地兜底（登录/档案/开局），兜得住就直接用本地数据
    if (r.status >= 500 && localFallback(req, res, apiPath, body)) return;
    // 维护期：其余接口上游会返回 503 且 body 带 maintenance，客户端一读到就弹维护墙。
    // 把 maintenance 字段摘掉，让客户端按普通错误降级（菜单照常渲染，只是没有榜单/新闻）。
    if (PB_MAINT && r.status >= 400) {
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) {
        try {
          const j = JSON.parse(buf.toString("utf8"));
          if (j && j.maintenance) {
            delete j.maintenance;
            const nb = Buffer.from(JSON.stringify(j));
            res.writeHead(r.status, {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.end(nb);
            return;
          }
        } catch { /* 非 JSON 直接透传 */ }
      }
    }
    res.writeHead(r.status, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": r.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    if (localFallback(req, res, apiPath, body)) return;
    send(res, 502, "proxy error: " + e.message);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.H = lightHeaders(u.pathname);
  if (req.method === "POST" && u.pathname === "/data/batch") return serveBatch(req, res);
  if (u.pathname === "/log") return send(res, 200, "ok"); // gta 页面日志端点（离线静默接受）
  if (req.method === "OPTIONS" && u.pathname.startsWith("/api-proxy")) {
    return send(res, 204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token, X-Device, X-Client",
      "Access-Control-Max-Age": "86400",
    });
  }
  if (u.pathname.startsWith("/api-proxy")) return serveProxy(req, res, u);
  serveStatic(req, res, u.pathname);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`复刻站点本地服务已启动: http://127.0.0.1:${PORT}/  (根目录 ${ROOT})`);
});

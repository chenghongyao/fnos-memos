#!/usr/bin/env node
// 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
// 本文件属于 Memos 飞牛打包的适配层（网关桥），与上游 usememos/memos 无关；
// 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
// 第三方声明见 app/server/NOTICE
/**
 * Memos · fnOS 统一网关桥接（Unix Socket → Unix Socket，可选再开一个 TCP 入口）
 *
 * 链路（统一网关，飞牛桌面入口走这条）：
 *   浏览器 http(s)://<NAS>:5666/app/Memos/...
 *     → nginx（/app/ → unix:/var/run/trim_http_cgi.socket）
 *     → trim_http_cgi（校验 NAS 登录态，注入 X-Trim-Userid / Username / Isadmin）
 *     → $TRIM_APPDEST/app.sock            ← 本进程（网关入口）
 *     → $TRIM_APPDEST/memos.sock          ← memos 本体（--unix-sock）
 *
 * 链路（可选 TCP 入口，安装向导里勾选后才有）：
 *   浏览器 http://<NAS>:<port>/...
 *     → 本进程（TCP 入口）→ $TRIM_APPDEST/memos.sock
 *
 * 两种入口的差别：
 *   - 网关入口在子路径 /app/Memos 下，memos 前端只认站点根，所以要剥前缀 + 改写正文。
 *   - TCP 入口就在站点根，memos 原生路径就对，**完全不改写**，直接透传。
 *
 * 关键点：
 *   1. 网关不会改写路径，转发进来的 req.url 原样带着 /app/Memos，所以这里要剥前缀。
 *   2. memos 前端把资源、接口、跳转全写成站点根的绝对路径（/assets/…、/memos.api.…），
 *      直接挂在子路径下会白屏。因此这里对 HTML / CSS / JS 做前缀改写，并注入运行时补丁。
 *   3. 只用 Node 内置模块，无 npm 依赖。
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
function argOf(name, def) {
    const i = process.argv.indexOf(name);
    if (i > -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
    return def;
}

const VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version || '1.0.0';
    } catch (e) {
        return '1.0.0';
    }
})();

const SOCK = argOf('--sock', process.env.MEMOS_GW_SOCK || '');
const UPSTREAM = argOf('--upstream', process.env.MEMOS_UPSTREAM_SOCK || '');
const PREFIX = (argOf('--prefix', process.env.MEMOS_GW_PREFIX || '') || '').replace(/\/+$/, '');
/** 可选的 TCP 入口（安装向导里勾选“开放端口”后才有），0 表示不开放 */
const TCP_PORT = parseInt(argOf('--port', '0'), 10) || 0;
/** TCP 入口监听地址，默认 0.0.0.0（局域网可访问） */
const TCP_HOST = argOf('--host', '0.0.0.0');
const HEALTH = '/_gw/health';
const ABOUT_PATH = '/_gw/about';

const STARTED_AT = Date.now();
const stats = { requests: 0, proxied: 0, rewritten: 0, errors: 0, lastError: null };

function log(msg) {
    console.log(`${new Date().toISOString()} ${msg}`);
}

/* ------------------------------------------------------------------ *
 * 改写规则（只用于网关入口）
 * ------------------------------------------------------------------ */

/** 运行时补丁：把站点根绝对路径补上网关前缀（fetch / XHR / history / WebSocket / EventSource） */
function shimScript(base) {
    const B = JSON.stringify(base);
    const code =
        '(function(){' +
        'var B=' + B + ';' +
        'function fix(u){try{' +
        'if(u==null)return u;' +
        'if(typeof u!=="string"){try{if(u instanceof URL)return fix(u.href);}catch(e){}return u;}' +
        'if(u.charAt(0)==="/"){' +
        'if(u.charAt(1)==="/")return u;' +
        'if(u===B||u.indexOf(B+"/")===0)return u;' +
        'return B+u;' +
        '}' +
        'var m=/^https?:\\/\\/([^\\/?#]+)([\\s\\S]*)$/.exec(u);' +
        'if(m&&m[1]===location.host){' +
        'var rest=m[2]||"/";' +
        'if(rest.charAt(0)==="/"&&rest!==B&&rest.indexOf(B+"/")!==0)return location.origin+B+rest;' +
        '}' +
        'return u;' +
        '}catch(e){return u}}' +
        'window.__memosGatewayFix=fix;' +
        'try{var f=window.fetch;if(f){window.fetch=function(i,o){try{' +
        'if(typeof i==="string")i=fix(i);' +
        'else if(i&&typeof i.url==="string"){var n=fix(i.url);if(n!==i.url)i=new Request(n,i);}' +
        'else if(i instanceof URL){i=fix(i.href);}' +
        '}catch(e){}return f.call(this,i,o)}}}' +
        'catch(e){}' +
        'try{var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{' +
        'if(typeof u==="string")arguments[1]=fix(u);' +
        '}catch(e){}return oo.apply(this,arguments)}}' +
        'catch(e){}' +
        'try{var ps=history.pushState,pr=history.replaceState;' +
        'history.pushState=function(a,b,u){try{if(typeof u==="string")arguments[2]=fix(u);}catch(e){}return ps.apply(this,arguments)};' +
        'history.replaceState=function(a,b,u){try{if(typeof u==="string")arguments[2]=fix(u);}catch(e){}return pr.apply(this,arguments)}}' +
        'catch(e){}' +
        'try{if(window.WebSocket){var OW=window.WebSocket;window.WebSocket=new Proxy(OW,{construct:function(t,a){' +
        'try{a[0]=fix(a[0]);}catch(e){}return Reflect.construct(t,a)}})}}catch(e){}' +
        'try{if(window.EventSource){var OE=window.EventSource;window.EventSource=new Proxy(OE,{construct:function(t,a){' +
        'try{a[0]=fix(a[0]);}catch(e){}return Reflect.construct(t,a)}})}}catch(e){}' +
        '})();';
    // 注意：结尾用 '</scr' + 'ipt>' 拼出来，避免脚本内容里出现字面量 </script>
    try { new Function(code); } catch (e) { log('WARN 运行时补丁脚本语法错误: ' + e.message); }
    return '<script data-memos-gateway="shim">' + code + '</scr' + 'ipt>';
}

function rewriteHtml(base, html) {
    let out = html.replace(
        /(\s(?:src|href|action|poster|formaction)\s*=\s*)(["'])\/(?!\/)/gi,
        (m, pre, q) => pre + q + base + '/'
    );
    // <base> 让页面里剩余的相对路径（assets/xxx.js）也落在网关前缀下
    const inject = '<base href="' + base + '/">' + shimScript(base);
    if (/<head(\s[^>]*)?>/i.test(out)) out = out.replace(/<head(\s[^>]*)?>/i, (m) => m + inject);
    else out = inject + out;
    return out;
}

function rewriteCss(base, css) {
    return css.replace(/url\(\s*(['"]?)\/(?!\/)/g, 'url($1' + base + '/');
}

/**
 * JS 改写：
 *   1. react-router v7 createRouter 的 basename 默认值 → 网关前缀（否则前端路由全部 404）
 *   2. react-router v6 的 basename:void 0 → 网关前缀（兜底）
 *   3. connect-es 的 baseUrl → 网关前缀（RPC 走 baseUrl + /memos.api.…）
 *   4. ${window.location.origin} → 带上前缀（分享链接、文件直链）
 *   5. vite preload helper 的 base → 网关前缀（否则动态 chunk 的 preload 全部 404）
 *   6. 静态资源字面量（logo 等）→ 带上前缀
 */
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把以 prefix 开头的字符串字面量补上网关前缀 */
function prefixLiterals(js, base, prefixes) {
    let out = js;
    for (const p of prefixes) {
        const re = new RegExp('(["\'`])' + escapeRe(p), 'g');
        out = out.replace(re, (m, q) => q + base + p);
    }
    return out;
}

function rewriteJs(base, js) {
    let out = js;
    // 1) .basename||"/"   （v7：let c = e.basename || "/"）
    out = out.replace(/\.basename\|\|(?:`\/`|"\/"|'\/')/g, '.basename||"' + base + '"');
    // 2) basename:void 0 （v6 兜底）
    out = out.replace(/basename:void 0/g, 'basename:"' + base + '"');
    // 3) connect-es baseUrl
    out = out.replace(/baseUrl:window\.location\.origin/g, 'baseUrl:window.location.origin+"' + base + '"');
    // 4) 模板字符串里的 origin
    out = out.replace(/\$\{window\.location\.origin\}/g, '${window.location.origin+"' + base + '"}');
    // 5) vite preload helper：return`/`+e  →  return`<base>/`+e
    out = out.replace(/return`\/`\+/g, 'return`' + base + '/`+');
    out = out.replace(/return"\/"\+/g, 'return"' + base + '/"+');
    // 6) 静态资源字面量
    out = prefixLiterals(out, base, ['/logo.webp', '/full-logo.webp', '/apple-touch-icon.png']);
    return out;
}

/* ------------------------------------------------------------------ *
 * 改写缓存（memos 的主 JS 约 1.2MB，避免每次都重写）
 * ------------------------------------------------------------------ */
const CACHE_MAX_ENTRIES = 96;
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_MAX_ITEM = 24 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

function cacheSet(key, buf) {
    if (buf.length > CACHE_MAX_ITEM) return;
    if (cache.has(key)) {
        cacheBytes -= cache.get(key).length;
        cache.delete(key);
    }
    cache.set(key, buf);
    cacheBytes += buf.length;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= cache.get(oldest).length;
        cache.delete(oldest);
    }
}

const REWRITE_CT = /^(?:text\/html|text\/css|text\/javascript|application\/(?:x-)?javascript|application\/manifest\+json)/i;

/** PWA manifest：图标、start_url、scope 都是站点根绝对路径 */
function rewriteManifest(base, text) {
    return text.replace(/("(?:src|href|start_url|scope)"\s*:\s*")\/(?!\/)/g, (m, p1) => p1 + base + '/');
}

function transform(base, ct, buf) {
    const text = buf.toString('utf8');
    if (/html/i.test(ct)) return Buffer.from(rewriteHtml(base, text), 'utf8');
    if (/css/i.test(ct)) return Buffer.from(rewriteCss(base, text), 'utf8');
    if (/manifest/i.test(ct)) return Buffer.from(rewriteManifest(base, text), 'utf8');
    return Buffer.from(rewriteJs(base, text), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 转发
 * ------------------------------------------------------------------ */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardHeaders(req, opts) {
    const out = {};
    for (const key of Object.keys(req.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        out[key] = req.headers[key];
    }
    // 需要改写正文，不能让上游压缩
    if (opts.rewrite) delete out['accept-encoding'];
    const prev = req.headers['x-forwarded-for'];
    const remote = (req.socket && req.socket.remoteAddress) || '';
    out['x-forwarded-for'] = prev ? prev + ', ' + remote : remote;
    // 网关（nginx）不会传 X-Forwarded-Proto：
    //   网关入口按 https 处理（https 链接在 http 页面里可用，反之会被浏览器当混合内容拦截）
    //   TCP 入口默认按 http 处理（浏览器直连 IP:端口，没有 TLS）
    out['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (opts.rewrite ? 'https' : 'http');
    out['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (opts.rewrite && PREFIX) out['x-forwarded-prefix'] = PREFIX;
    return out;
}

function rewriteLocation(base, loc) {
    if (typeof loc !== 'string' || !loc) return loc;
    if (loc.startsWith('/') && !loc.startsWith('//') && loc !== base && !loc.startsWith(base + '/')) {
        return base + loc;
    }
    return loc;
}

function send(res, code, body, headers) {
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    res.writeHead(code, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, headers || {}));
    res.end(body);
}

function sendHtml(res, code, html) {
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    res.writeHead(code, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
    });
    res.end(html);
}

function errorPage(title, message) {
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
        '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
        'background:#0b1220;color:#e2e8f0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
        '.box{max-width:640px;padding:28px;border:1px solid #ffffff14;border-radius:14px;background:#0f172a}' +
        'h1{margin:0 0 10px;font-size:19px}code{background:#ffffff10;padding:2px 6px;border-radius:5px}</style>' +
        '</head><body><div class="box"><h1>' + title + '</h1><p>' + message + '</p></div></body></html>';
}

/**
 * 转发一个请求到上游（memos 的 unix socket）
 * opts.rewrite = true  → 子路径模式：剥前缀后转发，并改写正文
 * opts.rewrite = false → 站点根模式：原样透传
 */
function proxy(req, res, upPath, search, opts) {
    const headers = forwardHeaders(req, opts);
    stats.requests++;
    stats.proxied++;

    const up = http.request({
        socketPath: UPSTREAM,
        method: req.method,
        path: upPath + (search || ''),
        headers: headers,
        agent: false,
    }, (upRes) => {
        const ct = String(upRes.headers['content-type'] || '');
        const outHeaders = {};
        for (const key of Object.keys(upRes.headers)) {
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            outHeaders[key] = upRes.headers[key];
        }
        // 让 nginx 关闭缓冲，SSE / 流式响应才能实时到浏览器
        outHeaders['x-accel-buffering'] = 'no';
        if (opts.rewrite && outHeaders.location) {
            outHeaders.location = rewriteLocation(PREFIX, outHeaders.location);
        }

        const needRewrite = opts.rewrite && REWRITE_CT.test(ct);
        if (!needRewrite) {
            if (!res.headersSent) res.writeHead(upRes.statusCode || 502, outHeaders);
            upRes.pipe(res);
            upRes.on('error', () => { try { res.destroy(); } catch (e) {} });
            return;
        }

        const cacheKey = upPath + '|' + ct + '|' + (outHeaders['content-length'] || '');
        const hit = cacheGet(cacheKey);
        if (hit) {
            outHeaders['content-length'] = hit.length;
            delete outHeaders['content-encoding'];
            if (!res.headersSent) res.writeHead(upRes.statusCode || 502, outHeaders);
            res.end(hit);
            upRes.resume();
            return;
        }

        const chunks = [];
        let size = 0;
        let overflow = false;
        upRes.on('data', (c) => {
            size += c.length;
            if (size > CACHE_MAX_ITEM) { overflow = true; chunks.length = 0; return; }
            chunks.push(c);
        });
        upRes.on('end', () => {
            let body = null;
            if (!overflow) {
                try { body = transform(PREFIX, ct, Buffer.concat(chunks)); }
                catch (e) { body = null; }
            }
            if (!body) {
                if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end('Memos 网关：响应过大或改写失败');
            }
            stats.rewritten++;
            cacheSet(cacheKey, body);
            outHeaders['content-length'] = body.length;
            delete outHeaders['content-encoding'];
            if (!res.headersSent) res.writeHead(upRes.statusCode || 502, outHeaders);
            res.end(body);
        });
        upRes.on('error', () => { try { res.destroy(); } catch (e) {} });
    });

    up.on('error', (err) => {
        // 客户端主动断开（页面跳转/刷新）不算错误
        if (req.destroyed || res.writableEnded || res.destroyed) {
            try { up.destroy(); } catch (e) {}
            return;
        }
        stats.errors++;
        stats.lastError = { at: new Date().toISOString(), path: upPath, error: err.code || err.message };
        log(`转发失败 ${req.method} ${upPath} -> ${UPSTREAM} : ${err.code || err.message}`);
        if (!res.headersSent) {
            sendHtml(res, 502, errorPage('Memos 服务未就绪', '无法连接 memos 进程（' + (err.code || err.message) +
                '）。请确认应用已启动，或查看 <code>' + '/vol1/@appdata/Memos/info.log' + '</code>。'));
        } else {
            try { res.destroy(); } catch (e) {}
        }
    });

    req.on('aborted', () => up.destroy());
    req.pipe(up);
}

/** WebSocket / Upgrade 透传（memos 当前前端未使用，留作兼容） */
function proxyUpgrade(req, socket, head, upPath, search, opts) {
    const headers = forwardHeaders(req, opts);
    const upstream = net.connect(UPSTREAM, () => {
        let raw = `${req.method} ${upPath}${search || ''} HTTP/1.1\r\n`;
        for (const key of Object.keys(headers)) {
            const val = headers[key];
            if (Array.isArray(val)) val.forEach((v) => { raw += `${key}: ${v}\r\n`; });
            else raw += `${key}: ${val}\r\n`;
        }
        raw += `Upgrade: ${req.headers['upgrade'] || 'websocket'}\r\n`;
        raw += 'Connection: Upgrade\r\n\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', (err) => {
        stats.errors++;
        log('WS 转发失败: ' + (err.code || err.message));
        try { socket.destroy(); } catch (e) {}
    });
    socket.on('error', () => { try { upstream.destroy(); } catch (e) {} });
    socket.on('close', () => { try { upstream.destroy(); } catch (e) {} });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
function splitUrl(rawUrl) {
    const u = rawUrl || '/';
    const i = u.indexOf('?');
    return i >= 0 ? { p: u.slice(0, i), q: u.slice(i) } : { p: u, q: '' };
}

/** 把网关路径剥成上游路径 */
function toUpstream(rawPath) {
    if (!PREFIX) return { ok: true, rel: rawPath };
    if (rawPath === PREFIX) return { ok: false, redirect: PREFIX + '/' };
    if (rawPath.startsWith(PREFIX + '/')) return { ok: true, rel: rawPath.slice(PREFIX.length) };
    return { ok: false, notFound: true };
}

function healthPayload(mode) {
    return {
        ok: true, app: 'Memos', version: VERSION, mode: mode,
        prefix: PREFIX, upstream: UPSTREAM, socket: SOCK,
        tcp: TCP_PORT > 0 ? { host: TCP_HOST, port: TCP_PORT } : null,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        stats: stats,
    };
}

/** 关于与许可信息（两个入口都提供） */
const ABOUT = {
    app: 'Memos',
    packaging: 'Memos for fnOS（第三方飞牛打包）',
    packagingVersion: VERSION,
    upstream: {
        name: 'usememos/memos',
        url: 'https://github.com/usememos/memos',
        site: 'https://usememos.com',
        version: '26.10-rc.1',
        binary: 'linux_arm64（官方发行版二进制，未修改）',
        license: 'MIT License',
        copyright: 'Copyright (c) 2025 Memos',
    },
    packagingLayer: {
        license: 'MIT License',
        copyright: 'Copyright (c) 2026 chenghongyao',
        files: ['app/server/bridge.js', 'cmd/*', 'config/*', 'wizard/*', 'app/ui/*', 'build.sh', 'tests/*'],
        notice: 'app/server/NOTICE',
        licenseText: 'app/server/LICENSE-MEMOS',
    },
    thirdParty: [
        { name: 'Node.js v24', license: 'Apache License 2.0', url: 'https://nodejs.org/', note: '作为独立应用安装，仅以子进程方式调用运行时' },
    ],
    disclaimer: '本应用为第三方打包，非 usememos 官方发行版。“Memos”名称与品牌归上游项目所有。',
};

function aboutPage() {
    const u = ABOUT.upstream;
    const p = ABOUT.packagingLayer;
    const rows = [
        ['上游项目', '<a href="' + u.url + '" target="_blank" rel="noopener">' + u.name + '</a>'],
        ['上游官网', '<a href="' + u.site + '" target="_blank" rel="noopener">' + u.site + '</a>'],
        ['内置版本', u.version + '（' + u.binary + '）'],
        ['上游许可', u.license + ' — ' + u.copyright],
        ['本打包', ABOUT.packaging + ' ' + ABOUT.packagingVersion],
        ['适配层许可', p.license + ' — ' + p.copyright],
        ['第三方声明', '<code>' + p.notice + '</code> / <code>' + p.licenseText + '</code>'],
    ].map((r) => '<tr><td style="padding:6px 18px 6px 0;color:#94a3b8;white-space:nowrap">' + r[0] + '</td><td style="padding:6px 0">' + r[1] + '</td></tr>').join('');
    const third = ABOUT.thirdParty.map((t) =>
        '<li><a href="' + t.url + '" target="_blank" rel="noopener">' + t.name + '</a> — ' + t.license + '（' + t.note + '）</li>').join('');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>关于与许可 · Memos</title><style>' +
        'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e2e8f0;' +
        'font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
        '.box{max-width:760px;padding:32px;border:1px solid #ffffff14;border-radius:14px;background:#0f172a}' +
        'h1{margin:0 0 4px;font-size:20px}h2{margin:26px 0 8px;font-size:15px;color:#cbd5e1}' +
        'table{border-collapse:collapse;width:100%}code{background:#ffffff10;padding:2px 6px;border-radius:5px;font-size:13px}' +
        'a{color:#38bdf8}ul{padding-left:18px;margin:6px 0}.muted{color:#94a3b8;font-size:13px;margin-top:24px}</style></head><body>' +
        '<div class="box"><h1>关于与许可</h1><div class="muted">' + ABOUT.packaging + ' ' + ABOUT.packagingVersion + '</div>' +
        '<h2>软件与来源</h2><table>' + rows + '</table>' +
        '<h2>其他第三方组件</h2><ul>' + third + '</ul>' +
        '<h2>说明</h2><p>' + ABOUT.disclaimer + '</p>' +
        '<div class="muted">本页面由网关桥提供：' + (PREFIX ? PREFIX + '/_gw/about' : '/_gw/about') + '</div>' +
        '</div></body></html>';
}

/** 网关入口：/app/Memos/... → 剥前缀 + 改写 */
function gatewayHandler(req, res) {
    const { p: rawPath, q: search } = splitUrl(req.url || '/');
    const route = toUpstream(rawPath);

    if (route.redirect) {
        res.writeHead(302, { Location: route.redirect + search, 'cache-control': 'no-store' });
        return res.end();
    }
    if (route.notFound) {
        return sendHtml(res, 404, errorPage('404 · 路径不在网关前缀下', '本应用只通过 <code>' + PREFIX + '/</code> 访问。'));
    }
    if (route.rel === HEALTH) {
        return send(res, 200, JSON.stringify(healthPayload('gateway')),
            { 'content-type': 'application/json; charset=utf-8' });
    }
    if (route.rel === ABOUT_PATH) {
        return sendHtml(res, 200, aboutPage());
    }

    const rel = route.rel === '' ? '/' : route.rel;
    proxy(req, res, rel, search, { rewrite: true, base: PREFIX });
}

/** TCP 入口：http://<NAS>:<port>/... → 站点根，原样透传，不改写 */
function tcpHandler(req, res) {
    const { p: rawPath, q: search } = splitUrl(req.url || '/');
    if (rawPath === HEALTH) {
        return send(res, 200, JSON.stringify(healthPayload('tcp')),
            { 'content-type': 'application/json; charset=utf-8' });
    }
    if (rawPath === ABOUT_PATH) {
        return sendHtml(res, 200, aboutPage());
    }
    proxy(req, res, rawPath || '/', search, { rewrite: false, base: '' });
}

function attachServer(server) {
    server.on('clientError', () => {});
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    return server;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
if (!UPSTREAM) {
    log('缺少 --upstream 参数');
    process.exit(1);
}
if (!SOCK && TCP_PORT <= 0) {
    log('缺少 --sock 或 --port 参数');
    process.exit(1);
}

const servers = [];

if (SOCK) {
    const gw = attachServer(http.createServer(gatewayHandler));
    gw.on('upgrade', (req, socket, head) => {
        const { p: rawPath, q: search } = splitUrl(req.url || '/');
        const route = toUpstream(rawPath);
        if (!route.ok || route.notFound) { try { socket.destroy(); } catch (e) {} return; }
        const rel = route.rel === '' ? '/' : route.rel;
        proxyUpgrade(req, socket, head, rel, search, { rewrite: true, base: PREFIX });
    });
    try { if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK); } catch (e) {}
    gw.listen(SOCK, () => {
        try { fs.chmodSync(SOCK, 0o666); } catch (e) {}
        log(`Memos 网关桥 ${VERSION} 网关入口已启动 socket=${SOCK} upstream=${UPSTREAM} prefix=${PREFIX}`);
    });
    gw.on('error', (err) => {
        log('网关 socket 监听失败: ' + (err.code || err.message));
        process.exit(1);
    });
    servers.push(gw);
}

if (TCP_PORT > 0) {
    const tcp = attachServer(http.createServer(tcpHandler));
    tcp.on('upgrade', (req, socket, head) => {
        const { p: rawPath, q: search } = splitUrl(req.url || '/');
        proxyUpgrade(req, socket, head, rawPath || '/', search, { rewrite: false, base: '' });
    });
    tcp.listen(TCP_PORT, TCP_HOST, () => {
        log(`Memos 网关桥 ${VERSION} TCP 入口已启动 http://${TCP_HOST}:${TCP_PORT}/ upstream=${UPSTREAM}`);
    });
    tcp.on('error', (err) => {
        log('TCP 端口监听失败: ' + (err.code || err.message) +
            (err.code === 'EADDRINUSE' ? '（端口被占用，请在应用设置里换一个端口）' : ''));
        process.exit(1);
    });
    servers.push(tcp);
}

function shutdown(sig) {
    log(`收到 ${sig}，准备退出`);
    for (const s of servers) { try { s.close(); } catch (e) {} }
    setTimeout(() => process.exit(0), 800).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

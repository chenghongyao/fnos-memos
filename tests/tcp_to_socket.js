#!/usr/bin/env node
// 版权与许可：MIT License, Copyright (c) 2026 chenghongyao
// 本文件属于 Memos 飞牛打包的适配层（网关桥），与上游 usememos/memos 无关；
// 上游项目：https://github.com/usememos/memos  （MIT, Copyright (c) 2025 Memos）
// 第三方声明见 app/server/NOTICE
/**
 * 测试辅助：把 TCP 端口的请求原样转发到 unix socket。
 * 用来在浏览器里验证「统一网关路径」（/app/Memos/...）的行为，
 * 因为正式部署时这一段是 nginx + trim_http_cgi 干的。
 *
 * 用法: node tcp_to_socket.js <unix_socket> <tcp_port>
 */
'use strict';
const net = require('net');

const sock = process.argv[2];
const port = parseInt(process.argv[3], 10);
if (!sock || !port) {
    console.error('用法: node tcp_to_socket.js <unix_socket> <tcp_port>');
    process.exit(1);
}

const server = net.createServer((client) => {
    const upstream = net.connect(sock);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
});

server.listen(port, '127.0.0.1', () => {
    console.log(`tcp_to_socket: 127.0.0.1:${port} -> ${sock}`);
});

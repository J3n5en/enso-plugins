# 第三方许可

本插件把下面的库打进发布包，安装时不再执行 `npm install`。

## postgres.js 3.4.7

- 来源：<https://github.com/porsager/postgres>
- 许可证：The Unlicense（公有领域）
- 作者：Rasmus Porsager
- 用途：PostgreSQL 线协议客户端。取消查询走协议里的 CancelRequest（`query.cancel()`），等价于 `pg_cancel_backend`。

## mysql2 3.14.5

- 来源：<https://github.com/sidorares/node-mysql2>
- 许可证：MIT
- 版权：Andrey Sidorov 及 mysql2 贡献者
- 用途：MySQL / MariaDB 纯 JavaScript 协议实现。未包含原生 `.node` 插件。取消查询另开一条到同一主机的连接，执行 `KILL QUERY <id>`。

MIT 许可的全文要点：可以自由使用、修改和再发布，但必须保留版权声明和本许可声明。软件按「原样」提供，不附带任何保证。

## sql.js 1.16.0

- 来源：<https://github.com/sql-js/sql.js>
- 许可证：MIT，见 `sql.js.LICENSE`。内含公有领域的 SQLite。
- 用途：仅当插件进程的 Node 没有内置 `node:sqlite` 时，作为 SQLite 的备用引擎。

## 产品形态

侧栏的连接树、在光标或选区运行 SQL、带环境标签的结果表格，参考了 Oscar Botteri 的 [orca-db-studio](https://github.com/oscarbotteri/orca-db-studio)（MIT，Copyright (c) 2026 Oscar Botteri）。本目录没有 Orca 的包，也没有调用 Orca 的宿主接口。实现是按 Enso 插件 API 写的。

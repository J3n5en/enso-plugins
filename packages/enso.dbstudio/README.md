# DB Studio

在 Enso 侧栏里连接 PostgreSQL、MySQL/MariaDB 和 SQLite，浏览库表并运行 SQL，不用为了看一张表再打开 TablePlus 或 DBeaver。

界面可以标环境（local / dev / staging / prod）。需要 Enso 0.3.4 或更新版本。

这不是 `enso.sqlite`。那个插件只读打开 `.db` / `.sqlite` / `.sqlite3` 文件。本插件不修改它。这边是多引擎的查询工作室，连接保存在插件自己的清单里。

## 和 Orca DB Studio 的差别

产品形态参考了 [Oscar Botteri 的 orca-db-studio](https://github.com/oscarbotteri/orca-db-studio)（MIT，Copyright (c) 2026 Oscar Botteri）：连接树、在光标处或选区运行语句、结果表格、环境标签。这里没有拷贝 Orca 的包，也没有调用 Orca 的宿主 API，实现全部对着 Enso 的插件接口重写。

实际碰到的差别：

| | Orca DB Studio | 本插件 |
| --- | --- | --- |
| 运行位置 | Orca 的受信任 worker | Enso 插件进程（完整的 Node）。侧栏页面在沙箱 iframe 里，只能通过 `enso.call` 问插件进程 |
| 密码 | Orca 的 `secrets:own` | Enso 只有只读的 `config.get()`。密钥字段由设置页或 `enso-server plugin config` 写入，文件权限 600，主进程还有内存缓存。侧栏保存密码时，插件把 JSON 写进宿主的 `extension-plugins/config/enso.dbstudio.json`（同样 600，只改 `passwords` 到 `passwords4`）。插件进程里另留一份内存副本，避免缓存还是旧值时连不上。Enso 没有 `config.set`。若你在设置里改了别的项，而主进程缓存里还没有这些密码，那次保存可能用旧缓存盖掉文件。保存连接后如果要改行数上限，先重新打开一次 Enso，或在侧栏里再存一次密码 |
| 网络权限 | Orca 自己的网络能力 | Enso 的 `net.domains` 只约束 `net.fetch` 的 HTTP(S) 主机名，管不了 Postgres / MySQL 的 TCP。本插件**不申请** `net.fetch`，也不打开任意网址。TCP 只连你保存的那一个主机和端口，或 `.env` 连接串里的主机。URL 查询参数里的 `host`、`port`、`socket` 会被忽略 |
| 查询文档 | 每个查询是一个 `.sql` 文件 | 侧栏草稿放在页面状态里，不往项目里写文件（没有 `fs.write`）。已有的文本 `.sql` 可以用文件查看器打开，默认仍是普通编辑器 |
| 结果上限 | 约 5000 行或 900KB | 默认 `LIMIT 100`（可在设置里改到 1–1000）。单次界面调用还要低于宿主的 1MB，所以一页最多约 100 行、载荷约 700KB。硬上限 5000 行。单元格预览 180 字，点开最多取回 512KB 文本或 256KB 二进制的十六进制 |
| SQLite | Node 24 的 `node:sqlite`，跑在单独线程 | 优先用 Node 内置的 `node:sqlite`（当前 Enso 的插件进程是 Node 22+，Electron 43 这一代带这个模块）。没有这个内置模块时，改用 sql.js，整库进内存，最大 64MB |

## 使用

1. 安装并启用插件，打开侧栏 **DB Studio**。
2. **新建**连接：填主机、用户、数据库，或粘贴 `postgres://`、`mysql://`、`mariadb://`。SQLite 从当前项目里选文件，或粘贴相对路径 / 绝对路径。
3. 点连接展开：连接 → 数据库 → schema → 表 / 视图。点一张表，编辑器里会出现 `SELECT * FROM … LIMIT 100` 并执行。
4. 改 SQL 后按 Ctrl/⌘ Enter，或点「运行」。有选区就只跑选区里的语句；没有选区就跑光标所在的那一条。
5. 点「取消」会让数据库停掉正在跑的语句，而不只是关掉界面上的转圈。
6. 点单元格可在下方看完整内容。`NULL` 用斜体显示。大整数和小数按十进制原文显示，不会先变成 JavaScript 的 Number。

在已保存的连接上按 Enter，可以编辑或删除。环境标签会显示在连接名旁边。

如果项目根目录的 `.env` 或 `.env.local` 里有 `DATABASE_URL`（名字可在设置里改），侧栏会多一条来自环境文件的连接。每次使用都重新读文件，不会把这条 URL 抄进连接清单。`.env.local` 覆盖 `.env`。

已有的 `.sql` 文本文件可以在文件标签右上角切换到 DB Studio。第一行如果是 `-- enso.dbstudio: connection=<id>`，会预先选中这个连接。查看器不会抢过默认编辑器。

## 密码

密码不进 `connections.json`，不进日志。保存时拆成最多 4 段 JSON，每段不超过 4000 个字符，放在密钥配置 `passwords`、`passwords2`、`passwords3`、`passwords4`。单条密码最长 1024 个字符。设置页只显示「已设置 / 未设置」。

编辑连接时密码留空，表示不改原来的密码。要清掉密码，删除这条连接再新建。

来自 `.env` 的密码只在当次连接时使用，不写入密钥字段。

## 查询、分页和取消

- 打开表，以及自己没写 `LIMIT` / `FETCH` 的 `SELECT`（含 `WITH … SELECT`、`SHOW`、`EXPLAIN`、`PRAGMA`、`RETURNING`），会补上配置里的行数上限，默认 100。
- `INSERT` / `UPDATE` / `DELETE` 不会被改写成带 `LIMIT` 的语句。工作室可以写数据，不是只读的。
- 结果按约 100 行一块从驱动里读。Postgres 用服务端游标，MySQL 用结果流，SQLite 在工作线程里按行 `step`。不会为了显示前 100 行把整张大表拉进界面。
- 一页放不下（接近 700KB）时，点「继续读取」。累计达到 5000 行就停下，并在状态栏说明。
- 取消：PostgreSQL 发线协议的 CancelRequest（`pg_cancel_backend`）。MySQL / MariaDB 用另一条连到**同一主机**的连接执行 `KILL QUERY`。SQLite 结束查询线程，下一次再打开文件。查询超时默认 30 秒，可在 1–110 秒之间配置；超时走同一条取消路径。
- 单元格预览超过 180 个字符会截断，点一下再取完整内容（文本最多 512KB，二进制最多 256KB 的十六进制）。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 侧栏页面，以及 `.sql` 文本文件查看器 |
| `fs.read`（整个项目） | 用宿主的文本接口读 `.env` / `.env.local` |

没有 `net.fetch`。数据库走插件进程自己的 TCP / TLS，目标只来自你保存的主机和端口，或环境文件里连接串的主机。插件不会因为 SQL 文本再去连别的机器。`dblink`、`LOAD DATA` 这类语句如果数据库账号允许，是数据库服务器自己的行为；MySQL 的 `LOCAL INFILE` 没有打开，服务器不能借客户端读本机文件。

SQLite 的二进制不能走 `fs.readText`（那是 UTF-8，还有 5MB 上限）。相对路径会解析进当前项目，拒绝 `..` 和指向项目外的符号链接。你粘贴的绝对路径由插件进程直接打开，这一步和 `enso.sqlite` 读原始字节的方式相同。`node:sqlite` 不把整库拷进 JS 堆；sql.js 备用路径会，所以限制 64MB。文件最大按 8GB 拒绝，避免误开一个不是数据库的巨大文件。

## 驱动

| 引擎 | 实现 |
| --- | --- |
| PostgreSQL | [postgres.js](https://github.com/porsager/postgres) 3.4.7，纯 JavaScript，打进 `vendor/drivers.cjs` |
| MySQL / MariaDB | [mysql2](https://github.com/sidorares/node-mysql2) 3.14.5 的纯 JavaScript 协议。`bigint` / `DECIMAL` 保持字符串 |
| SQLite | Node 内置 `node:sqlite`（`readBigInts`）。没有该模块时用 sql.js 1.16.0 |

安装插件时不会执行 `npm install`，目录里也没有原生 `.node`。`int8`、无符号大整数和小数不以 IEEE 浮点返回，所以 `9007199254740993` 不会变成 `9007199254740992`。sql.js 备用引擎做不到这一点，超过 `2^53-1` 的整数会丢失精度；状态栏不会单独提示，请尽量使用带 `node:sqlite` 的 Enso。

加密：`disable` 是明文 TCP。`require`（以及 URL 里的 `verify-ca`）加密但不校验证书，因为没有 CA 文件这项配置。`verify-full` 使用 Node 自带的信任库并检查主机名。URL 里的 `allow` / `prefer` 按不加密处理，避免本地库因为证书失败而连不上。

Unix socket 不使用。主机名里的逗号、路径和多主机 URL 会被拒绝，避免驱动自己再拆出另一个地址。IPv6 写成 `postgres://user@[::1]/db` 这种带方括号的形式即可。

编辑器是页面里的纯 JavaScript 高亮（关键字、字符串、数字、注释），补全来自当前 schema 的表和列，以及方言关键字。不是 CodeMirror，也没有原生模块。Ctrl/⌘ Enter 运行，Ctrl/⌘ Space 打开补全。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `envVar` | `DATABASE_URL` | 从 `.env` / `.env.local` 读取的变量名 |
| `rowLimit` | `100` | 1–1000，打开表和没有 `LIMIT` 的查询 |
| `queryTimeout` | `30` | 1–110 秒 |
| `passwords` … `passwords4` | 空 | 密钥。由侧栏写入 |

插件进程空闲大约 5 分钟后会退出，打开的游标会关掉。下次查询会重连，并从密钥配置重新读密码。

## 限制

- 不隐藏你在 SQL 里明确写了的 `pg_catalog` 访问，但树默认不列出 `pg_catalog`、`information_schema`、`pg_toast*`、`pg_temp_*`，以及 MySQL 的 `mysql`、`sys`、`information_schema`、`performance_schema`（当前库除外）。
- 一次界面调用最长 120 秒。更长的查询请调高超时；超时上限是 110 秒，给宿主留一点余量。
- 结果网格不是虚拟滚动。继续读取会把已经取回的行留在页面里，到 5000 行为止。
- 同名列在 Postgres 的对象行里可能折叠。打开表时用 `SELECT *`，列顺序以驱动返回的列清单为准。
- MariaDB 的会话超时优先用 `max_statement_time`，不支持时退回客户端取消。
- 不支持 SQLCipher 等加密的 SQLite 文件。

## 许可

实现是本仓库的代码。灵感和产品形态来自 Oscar Botteri 的 orca-db-studio（MIT）。驱动许可见 `vendor/LICENSES.md`。

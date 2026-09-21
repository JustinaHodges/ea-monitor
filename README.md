# 四季常春监控公益版

**赞助 Solana：** `JCZp9REG5AGhsr4NpkchzNdRvUwxJWNH4dhTzuGNX9xh`

开源的 MT4/MT5 EA 监控网站：登录后台、看持仓与盈亏日历、生成分享页、接收 EA 上报。

任何人都可以克隆本仓库，自己部署一套，和 [https://688118.xyz/](https://688118.xyz/) 同类站点。

## 仓库里有什么

| 目录 | 作用 |
|------|------|
| `public/` | 网站页面（登录 / 看板 / 分享） |
| `src/` | API 与业务逻辑 |
| `server/` | Node.js + SQLite 服务端（推荐自建） |
| `mql/` | MT4/MT5 EA 监控 |
| `schema.sql` | 数据库表结构 |
| `deploy/` | systemd / Nginx 示例 |
| `docs/` | 安装说明、站点功能说明与截图 |

界面与功能介绍见：[docs/站点功能说明.md](docs/站点功能说明.md)

## 最快部署

```bash
git clone https://github.com/JustinaHodges/ea-monitor.git
cd ea-monitor/server
cp .env.example .env
# 编辑 .env：把 ADMIN_TOKEN 改成你的密码

npm install
npm start
```

浏览器打开 `http://服务器IP:8787`，用 `ADMIN_TOKEN` 登录。

上线域名 + HTTPS 的完整步骤：[docs/宝塔安装.md](docs/宝塔安装.md)

## 说明

- 数据存在服务器本地 SQLite（`server/data/`），请自行备份
- 请尽快修改默认管理员密码，不要把 `.env` 提交到公开仓库

## License

本项目开源，可自由使用、修改与部署。

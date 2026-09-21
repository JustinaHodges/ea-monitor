# EA Monitor

MT4/MT5 EA 监控看板（自建部署）。

线上示例：[https://688118.xyz/](https://688118.xyz/)

## 包含什么

- `public/` 网站前台（登录 / 看板 / 分享页）
- `src/` 接口与业务逻辑
- `server/` Node.js + SQLite 服务端
- `mql/` MT4/MT5 监控 EA
- `schema.sql` 数据库结构
- `docs/`、`deploy/` 安装部署说明

## 本地运行

```bash
cd server
cp .env.example .env
# 编辑 .env，设置管理员密码等

npm install
npm start
```

打开 `http://localhost:8787`。

详细安装见 [docs/宝塔安装与授权.md](docs/宝塔安装与授权.md) 与 [server/README.md](server/README.md)。

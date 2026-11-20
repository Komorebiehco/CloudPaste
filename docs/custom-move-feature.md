# 文件与文件夹移动

挂载浏览支持单项和批量移动：

1. 右键文件或文件夹，选择“移动”；也可勾选多个项目后点击底部工具栏的“移动”。
2. 在弹窗中进入目标文件夹，或输入目标路径并点击“前往”。
3. 点击“移动到这里”，查看每项结果。成功项目会从源目录列表移除。

移动保留原名称，目前限于同一存储挂载。Telegram 使用原生目录索引移动，不重新上传文件内容。目标同名项不会被覆盖；该项明确失败后，批量操作继续处理后续项目。网络中断或服务端结果不明确时暂停后续项目，先核对源和目标目录，不自动重放写请求。

源与目标都复用 `fs.rename` 权限策略。挂载根目录、当前目录、文件夹自身及其后代路径不允许作为有效移动组合。跨挂载移动不在本功能范围。

## API

```http
POST /api/fs/move
Content-Type: application/json
Authorization: Bearer <admin-session>
```

```json
{
  "sourcePath": "/telegram/source/file.txt",
  "targetDirectory": "/telegram/target"
}
```

成功返回 `data.source` 和 `data.target`。名称冲突返回 HTTP 409，无效路径返回 HTTP 400。每个请求移动一项，前端串行汇总批量结果。

## 验证

```sh
cd backend
node --test test/fs-move.test.js test/fs-directory-aggregates.test.js test/telegram-webdav-errors.test.js
```

测试覆盖文件和目录的原生移动、真实驱动契约、同名冲突、跨挂载、挂载根、子目录、只读能力、缺失源、目标非目录、上游失败回执，以及原 Telegram 上传修复回归。

目录统计查询改为字面前缀范围匹配，避免 D1 的 `LIKE/GLOB` 模式 50 字节限制导致长路径目录列表返回 HTTP 500，同时正确处理 `_`、`%`、中文和 emoji。相关测试使用内存 SQLite 执行实际 SQL。

浏览器验收使用专用合成测试数据，检查桌面右键、移动端工具栏、重名后继续、网络失败后暂停、键盘焦点以及完整内容哈希。不要用正式备份替代测试数据。

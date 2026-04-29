# 收藏文档/知识库批量下载

## 概述

在 popup 的知识库选择器中新增"收藏"分组，支持批量下载用户收藏的文档和知识库。加密内容延后处理，优先下载所有未加密内容。

## API

- 获取收藏列表：`GET /api/mine/marks?offset=0&limit=100&type=all`
- 获取知识库文档：`GET /api/docs?book_id={id}`（404 = 需要密码）
- 密码验证：`PUT /api/books/{id}/verify`（body: `{password: RSA加密串}`）
- 所有请求必须带正确的 `Origin: https://www.yuque.com` 和 `Referer: https://www.yuque.com/`

## 收藏数据结构

marks API 返回的每个 action 项：
- `action_name`: `mark_doc`（收藏文档）/ `mark_book`（收藏知识库）
- `target_type`: `Doc` / `Book`
- `target.isEncrypted`: 仅 Doc 有，`true` 表示文档加密
- `target.id`, `target.title`/`target.name`: 目标信息
- `target_book`: 所属知识库（仅 mark_doc 有）

## 下载目录结构

```
[subfolder]/
  收藏/
    ├── [知识库A名称]/       ← mark_book 整个知识库
    │   ├── doc1.md
    │   └── doc2.md
    └── [知识库B名称]/       ← mark_doc 按所属知识库分组
        └── 收藏的文档.md
```

mark_doc 按其 `target_book.name` 分组到对应知识库文件夹下。

## 加密处理

1. 文档级：`target.isEncrypted === true` → 标记 encrypted，延后
2. 知识库级：`/api/docs?book_id=x` 返回 404 → 标记 needs_password，延后
3. 下载顺序：所有未加密 → 逐个提示密码处理加密项
4. 密码加密规则：RSA 1024-bit，明文 = `{Date.now()}:{password}`，4位密码

## Popup UI 变更

book selector 下拉新增分组：
```
── 收藏 ──
☐ 我的收藏 (N项)
```

选中"我的收藏"后：
- 获取文件信息时调用 marks API
- mark_book → 再获取其文档列表
- mark_doc → 直接加入文件列表
- 加密项在日志中标记，下载完未加密内容后提示输入密码

## 密码输入流程

未加密内容全部下载后：
1. 日志区显示"N 个加密项需要密码"
2. popup 中弹出 modal，显示加密项名称 + 4位密码输入框
3. 输入密码 → RSA加密 → PUT verify → 成功则下载
4. 支持跳过当前项
5. 错误处理：400=密码错误，429=次数超限

## 技术要点

- JSEncrypt 库用于 RSA 加密，需 bundle 进扩展
- marks API 支持分页（offset/limit），需处理超过100条的情况
- 复用现有 exporter 导出流程，仅扩展文件列表来源
- 所有 fetch 请求必须设置 Origin 和 Referer 头

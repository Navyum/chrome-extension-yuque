---
description: 消息通信规范
globs: src/core/messaging.js,src/ui/messaging.js
---

# 消息通信

- 导出流程涉及 background ↔ popup 双向消息通信
- 修改或新增消息类型时，必须同步更新 `src/core/messaging.js` 和 `src/ui/messaging.js`
- 消息类型常量定义在 `src/core/constants.js`

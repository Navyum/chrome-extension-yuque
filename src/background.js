import { registerRuntimeHandlers, maybeResumeExport } from './core/exporter.js';
import { initDownloadHooks } from './core/downloads.js';
import { loadState } from './core/state.js';
import { sendLog } from './core/messaging.js';

initDownloadHooks();
registerRuntimeHandlers();

// Override Referer for Yuque CDN image requests (bypass hotlink protection)
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1, 2, 3],
  addRules: [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.yuque.com/' }
        ]
      },
      condition: {
        urlFilter: '||cdn.nlark.com/',
        resourceTypes: ['xmlhttprequest', 'image']
      }
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.yuque.com/' }
        ]
      },
      condition: {
        urlFilter: '||cdn.yuque.com/',
        resourceTypes: ['xmlhttprequest', 'image']
      }
    },
    {
      id: 3,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.yuque.com/' }
        ]
      },
      condition: {
        urlFilter: '||www.yuque.com/api/',
        resourceTypes: ['xmlhttprequest']
      }
    }
  ]
});

(async function bootstrap() {
  const { restored, error } = await loadState();
  if (restored) {
    sendLog('已从存储中恢复任务状态。');
  } else if (error) {
    sendLog('恢复任务状态失败，请重新获取文件信息。');
  }
  await maybeResumeExport();
})();

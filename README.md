# 拾頁書店｜AI 線上客服 Demo

用 **Google Apps Script + Google Sheet + Telegram + NVIDIA NIM LLM** 打造的 AI 客服系統示範：
客人可以在 Telegram 或商店網頁的對話框詢問、找書、下單、查單、取消，AI 處理不了就轉真人，
店家在後台看所有對話、回覆客人、管理訂單與庫存。

| 入口 | 網址 / 位置 | 用途 |
|---|---|---|
| 商店頁 | `/exec` | 簡易電商：分類、搜尋、購物車、結帳、查訂單、右下角 AI 對話框 |
| 後台 | `/exec?page=admin` | 總覽、客服對話（可真人接手回覆）、訂單狀態、商品庫存、AI 追蹤 |
| Telegram bot | webhook → `/exec`（POST） | 客人詢問與下單 |
| Google Sheet | `SHEET_ID` | 資料庫（products / orders / order_items / sessions / chat / faq / console.log / ai_trace） |
| NVIDIA NIM | `integrate.api.nvidia.com` | LLM（`google/gemma-4-31b-it`，備援 `openai/gpt-oss-20b`） |

## 架構

```
Telegram ──POST(update_id)──┐
                            ├─ doPost ─┬─ Telegram → ChatBot.handle ─┐
商店頁 / 後台 ─POST(source:web)┘          └─ WebApi.handle ───────────┤
       └─ (fetch 失敗時) google.script.run.webApi ──────────────────┘
                                                                     │
ChatBot（ReAct 迴圈）── NvidiaService ── NVIDIA NIM                  │
   └─ Tools ── Store（下單／庫存／訂單規則）── DB ── Google Sheet ◀───┘
                 └─ Notify ── Telegram（店家通知頻道）
```

- **規則只寫一份**：網頁結帳、AI 工具、後台都呼叫 `Store`，庫存、運費、可否取消不會因入口不同而不同。
- **AI 不能編造**：書價、庫存、訂單狀態只能來自工具結果；下單前必須讓客人確認摘要。
- **身分由系統注入**：工具的 sessionId 不是模型參數，模型無法冒用別人查單。
- **轉真人**：客人輸入 `/human` 或 AI 判斷需要時切成真人模式，AI 停止回覆、通知店家；後台回覆會即時推到 Telegram，網頁訪客由對話框輪詢取得。
- **AI 可查驗**：每次 AI 回覆都在 `ai_trace` 留一筆紀錄（模型看到的歷史、每一輪用哪個模型／耗時／token、有沒有重試或改用備援、叫了哪些工具與參數、工具回傳什麼、最後回覆）。後台「AI 追蹤」分頁逐步呈現，對話裡的 AI 訊息可一鍵跳過去；同頁也能看目前的 system prompt 與工具定義。

## 首次設定

程式碼已透過 clasp 推上 Apps Script 並建立固定部署。在 Apps Script 編輯器（`clasp open`）依序：

1. 執行 `setupSheets` —— 第一次會要求授權；沒有 `SHEET_ID` 時自動建立試算表並寫入屬性
2. 執行 `seedSampleData` —— 寫入 12 本範例書與 FAQ
3. 專案設定 → 指令碼屬性，新增：

   | Key | 說明 |
   |---|---|
   | `TELEGRAM_API_KEY` | @BotFather 給的 bot token |
   | `NVIDIA_API_KEY` | NVIDIA NIM API 金鑰 |
   | `ADMIN_PASSWORD` | 後台登入密碼，也用於 Telegram `/admin <密碼>` 綁定店家通知 |
   | `DEBUG_MODE` | 選填，`false` 關閉 LLM 呼叫紀錄 |

4. 執行 `setupTelegramWebhook` —— 把 bot 指到這個部署並註冊指令選單
5. 執行 `setupTriggers` —— 每日 04:00 清理過期對話與日誌
6. 執行 `checkConfig` 確認全部 ✅；`testNvidia` 實打一次 LLM
7. 店家用自己的 Telegram 對 bot 輸入 `/admin <密碼>`，之後新訂單與轉真人會推播到那個聊天室

## 開發流程

```bash
git config core.hooksPath .githooks   # 每個 clone 一次
node tests/run.cjs                    # 跑測試
git push                              # 推到 main → 自動測試 → clasp push → clasp deploy（網址不變）
```

測試把全部 `.gs` 載進 Node，用 `tests/gas-mock.cjs` 在記憶體模擬 Sheet、Cache、UrlFetch 等服務，
LLM 回應由測試預先排好，涵蓋下單／庫存／查單權限／ReAct 迴圈／備援模型／doPost 路由／後台權限。
測試失敗就不會部署。

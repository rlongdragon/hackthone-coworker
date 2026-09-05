# Coworker!

**企業 AI 同事平台** — 每位員工都有一個 AI 同事:管理待辦與行事曆、參與專案、擁有長期記憶、每天早上給你簡報。全部跑在自己的機器上,**不依賴任何外部 SaaS**(唯一的對外連線是你自己的 OpenAI 格式 LLM gateway)。

規格書：https://w.rlong.me/coworker-network (FR-P 個人代理 / FR-D 部門大腦 / FR-M 主管代理 / FR-C 跨層協作)

## 功能

### 對話代理(FR-P)
- assistant-ui 前端 + AI SDK v5 後端,串流輸出、工具呼叫
- 工具：待辦(新增/列出/完成)、行事曆(建立/查詢/事件筆記)、專案看板(查看/開卡/拉狀態/指派)、專案文件閱讀、長期記憶(儲存/召回)
- 對話存 Postgres,自動命名標題、可改名/刪除、側欄即時更新、可摺疊,`/chats` 統一管理所有對話(搜尋、改名、刪除)
- 專案內可開專案對話：AI 自動帶入專案成員、看板狀態、文件清單作為上下文

### 長期記憶(FR-P-01)
- pgvector 語意召回,相關記憶自動注入每輪對話
- Embedding **完全本機執行**：transformers.js(`Xenova/multilingual-e5-small`,384 維,量化),不需要 embedding API

### 行事曆
- FullCalendar 月/週/日檢視,拖曳建立、拖曳移動、調整長度
- 事件詳情含筆記;「請 AI 記錄」會帶完整事件脈絡寫入 AI 筆記
- `events.source / external_uid` 已預留 CalDAV/ICS 欄位,待接公司信箱行事曆

### 專案協作
- 專案建立/封存、擁有者管理成員、伺服器端 RBAC(成員才能看、擁有者才能管)
- **看板(kanban)**：卡片拖曳換狀態、指派負責人、自訂欄位(狀態),AI 也能操作卡片
- **專案文件**：上傳/下載/刪除(配額 20MB/檔、100 檔與 200MB/專案),AI 可直接讀取文字類文件內容回答問題
- 專案對話屬於個人(成員只看得到自己的),主管永遠看不到對話內容(FR-C 隱私邊界)

### Agent Sandbox(通用執行環境)
- 每位員工一個獨立 Linux 容器(gVisor runtime 隔離、**無網路**、非 root、資源上限),AI 同事可在裡面跑指令
- 預裝文書工具：pandoc、pdftotext、python3(openpyxl/python-docx/python-pptx/pypdf/reportlab/weasyprint)、node、`doc2pdf`(含 Noto CJK 字型,中文 PDF 一鍵產)
- `/workspace` 是 per-employee volume,跨對話持久 — agent 可把常用流程存成 `/workspace/skills/` 腳本,能力隨時間累積
- 聊天可直接夾檔給 AI：非圖片/文字附件自動複製進 sandbox(標記為不可信資料),AI 用 runCommand 解析
- AI 產出的檔案可交回：`deliverFileToChat` 給聊天下載連結(任何對話)、專案對話另可存回專案文件
- 容器閒置 15 分鐘自動停止(volume 保留),下次使用秒級喚醒;所有指令寫入審計日誌

### 工具庫(團隊共用工具)
- 兩種工具,都存 DB(**新增工具 = 一筆資料,不用改程式、不用 redeploy**)：
  - **skill**：沙箱腳本(bash/python),AI 用 `runSkill` 在自己的 sandbox 跑
  - **action**：外部整合(HTTP),AI 用 `callAction` 由 server 端呼叫,可挑一個部門憑證
- 三層 scope：個人 / 部門 / 全公司;同範圍的 AI 同事自動看得到、能呼叫(例:工程部「開 git 卡片」action)
- 憑證加密存(AES-256-GCM,主金鑰 `TOOL_SECRET_KEY`/`AUTH_SECRET`),**永不進 sandbox / AI context / 審計日誌**,只在呼叫當下 server 端解密注入
- 敏感 action 走 HITL 確認卡片;每次呼叫寫審計;`/tools` 頁自助管理(建立權限沿用 RBAC:個人人人可、部門 manager、全公司 admin)

### MCP 外部工具(FR-T-MCP)
- 接入外部 [MCP](https://modelcontextprotocol.io) server(http Streamable / stdio 本機指令),工具自動併入 agent;可見性沿用工具庫模型(個人/部門/全公司)
- **投毒審核**:新增後自動連線列工具,兩層檢查 —— 確定性掃描(隱藏 unicode、注入語句、憑證關鍵詞、敏感參數)守 fail-safe 底線 + LLM 審核 agent(工具描述當不可信資料)標紅可疑句;agent 只能把風險判**更嚴**,不能放寬
- **auto / 需審批 / 封鎖**:每工具一個 policy,唯讀類自動跑、有副作用類走 HITL 審批卡片、破壞/惡意類封鎖;預設偏嚴,管理者在 `/admin/mcp` 逐工具確認才啟用
- **rug-pull 防護**:核准當下把工具描述+schema 做 hash pin,執行期比對,描述被改就自動停用該工具、要求重審(信任重置)
- **輸出當資料**:MCP 工具回傳一律 `<mcp-result>` 框住標示不可信,不當指令;連線失敗降級不擋聊天
- **從 GitHub repo 安裝**(admin/org):貼 repo URL + **釘死 commit**,clone → 供應鏈掃描(install script、eval/child_process、憑證讀取、無 lockfile)→ 依賴裝 `--ignore-scripts` → 在 **`--network none` gVisor 容器**內執行(egress deny + 唯讀掛載 + cap-drop 兜底,審核只是分診不是防線)
- 密鑰(stdio env / http header)AES-256-GCM 加密存,不落 server row、不進模型;所有變更寫審計

### 受治理的委派 + 自我紅隊(agent-society)
一群照公司權限彼此協作又不越權、還會全天候攻擊自己找漏洞的 AI 同事。兩根支柱共用同一張跨代理權限圖。
- **受治理委派(Pillar 1)**:`askCoworker` 把問題委派給另一位同事的代理當**子執行**;有效權限 = `caller ∩ callee` 的**工具可見度交集**,在 `lib/tool-store.ts` 的 PEP 邊界計算,**不寫在 system prompt**(prompt 級「別洩漏」文獻失敗率 35–51%)。委派鏈只會**收斂不會放大**(交集單調遞減 = macaroon caveat);每一跳每個工具都重查交集,出處寫審計。money shot:業務代理問財務代理「工程部 Q3 薪酬」→ 資料存在但交集移除該工具 → 拒答;換 CFO 登入同一問題 → 回答。同代理同資料,權限決定。
- **跨部門 HITL**:跨部門委派可要求 callee 本人先同意(重用 pending action + Telegram 批准鈕);同意後仍受交集權限約束。
- **自我紅隊(Pillar 2)**:紅隊代理持續對在線代理(真記憶 + 已核准工具 + Pillar-1 權限圖)發攻擊樣板(記憶時炸彈、confused-deputy、過度授權;種子取自 PyRIT/garak/AgentDojo),藍隊自動收緊。
- **記憶出處(taint)**:`memories.provenance`(trusted / untrusted_derived)+ `quarantined`;召回時排除隔離列(讀取期強制,不只標記);紅隊偵測到不可信記憶被一般查詢召回 → 藍隊隔離該列。
- **權限圖稽核**:靜態列舉每個代理的 scope 授予,標出過度授權(非管理員可直接用 org 敏感動作);因交集只收斂,升權風險 = 直接過授,正是此處所抓。
- **治理儀表板** `/admin/governance`:誰問誰、被交集擋掉什麼、紅隊抓到什麼、洩漏計分板(治理 vs framework-default 對照)。
- 誠實邊界:強制在 PEP/工具邊界、非 prompt;偵測是機率性 —— 定位為「持續偵測 + 縮小爆炸半徑」,非「解決注入」。宣稱僅限三者**組合**之新穎:org-RBAC 推導且被強制的跨代理資訊流 + 活體社會 + 閉環自我紅隊;延伸 AgentLeak / SoK(2512.06914)/ CaMeL(2503.18813)/ AgentPoison,非發明。
- DDL 見 `web/db/agent-society.sql`(memories 出處欄 + `attack_findings`;`docker exec -i coworkers-db-1 psql -U coworker -d coworker < db/agent-society.sql`)。

### A2A 透明帳本(a2a-ledger)
「不留紀錄 = 不執行」。代理間查詢多一層 **scope 交集 PEP**,而且被查的**當事人看得到誰查了什麼、被允許或被拒絕**。
- **scope PEP**:`askCoworker` 要標 scope(`project` / `team` / `private` / `sensitive`)。`sensitive`(請假原因、健康、薪資)與 `private` **只有本人**可存取 —— 主管、admin 都擋、無 HITL 例外;`project`/`team` 看共同專案或直屬主管。決策在 `lib/pep.ts`,不在 prompt。
- **內容底線**:模型自報的 scope 只能被內容比對**往上收緊**(`stricterScope(declared, detectMinimumScope(question))`),把敏感問題標成 project 不會繞過。
- **帳本**:每次 A2A 查詢(允許或拒絕)先寫 `audit_log`(subject / scope / allowed / 被擋欄位 / 目的)再執行;跨部門 HITL 在同意後才記,拒絕永不記成允許。
- **當事人視角** `/me/ledger`:「今天有 N 筆關於你的查詢,✅ 允許 X / ⛔ 拒絕 Y」,含被拒絕的敏感查詢與通知;`匯出 JSON` 一鍵下載自己的帳本(GDPR 式)。**現行產品/法規對職場代理都只揭露「被允許」的存取,「被拒絕」是本產品獨有**(措辭:No product ships this,非 Nobody can)。
- **通知**:寫進 `notifications` 表 + Telegram 推播當事人(已綁定者,≤5 秒)。
- **團隊代理**:每個專案一個代理身分(scope=team、無工具),只看團隊自己產出的看板/檔案/會議決議作答並附出處;非成員 404。

### 協作資料流入:會議記錄 / ASR / Telegram 群組摘要(collab)
- **會議記錄**(專案頁):上傳會議音檔或貼逐字稿 → `collab_events`(scope=team、標 tainted、寫入期分類)→ 本地模型抽「決議 / 行動項目」,全部「需確認」→ 人工勾選、指定負責人 → 建立待辦(`assignedBy` 記誰派的);**跨部門指派要被指派者本人同意**(HITL)。被指派者待辦頁顯示「由 X 指派」。
- **自架 ASR**:`lib/asr.ts` 呼叫 AiMeetingMinutes(FunASR Nano + 說話者分離,跑在 GPU 機經 Tailscale,`ASR_BASE_URL`),`POST /api/transcribe` + SSE job stream → 帶說話者的逐字稿;不用外部 ASR SaaS。服務端啟動見 `docs`/lab 機 `run-asr.sh`。
- **Telegram 群組摘要**:開了 `/group_context on` 的群組才保存訊息;`/digest [小時]` 或每日彙整 → 同一條 collab_events + 抽取流程 → 出現在綁定專案的「會議記錄」。
- **治理儀表板閉環**:紅隊新增 `mcp_drift`(重列已啟用 MCP、hash 比對,漂移 → 自動封鎖)、過度授權自動停用工具;每筆發現可「收緊 / 封鎖 / 再跑一次」;委派鏈逐跳視覺化(可用工具數、−交集移除)。
- DDL 見 `web/db/a2a-ledger.sql`;`npm run test` 跑全部 worker 測試。

### 派工 / 專案頻道 / 信箱(P4,collab)
- **派工**:專案頁「指派任務」(或會議行動項目確認)→ 同部門直接建待辦並通知;**跨部門要被指派者本人同意**(HITL `dispatch.assign`)。待辦標「由 X 指派」。
- **專案頻道** `/projects/:id/chat`:每專案一個 `#general`,成員即時(SSE,不用 WebSocket);打 `@agent` 召喚團隊代理 —— 它以自己的 team scope 作答,**提及不會提升發話者權限**;非成員 404。
- **我的信箱** `/me/mail`:用自己的 IMAP/SMTP 帳密連接(自驗、無 Graph/OAuth 中介),密碼 AES-256-GCM 存 `tool_secrets`(`mail/<employeeId>`),不進模型。收信 → `collab_events(mail, private, tainted)` + 決議/行動項目抽取(依 UID 增量);**寄信一律走 HITL**(`mail.send`,本人確認才用自己的 SMTP 寄;代理工具 `sendEmail` 只會送審)。
- demo/測試用自架信件伺服器:`docker run -d --name coworkers-greenmail -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" greenmail/standalone:2.1.0`(IMAP 127.0.0.1:3143、SMTP 3025、任何帳密可登入)。

### 人工審核(HITL)
- 敏感工具(調部門、改角色)不直接執行：先建立 pending action,聊天中出現確認卡片
- 按下確認才執行,執行當下**重新查 DB 驗證權限**、寫入審計日誌;10 分鐘過期;重新整理頁面後卡片狀態從 DB 還原,不會重複執行

### Telegram 頻道
- 同一套 agent 核心(`lib/agent-run.ts`)接上 Telegram:私訊 bot = 網頁聊天鏡像(sandbox、工具庫、行事曆、記憶全套),對話同步出現在 `/chats`
- 綁定：網頁「今日總覽」產生一次性 6 碼 → 私訊 `/link <碼>`;身分只認 Telegram 數字 user ID
- **串流輸出**:訊息逐段長出(progressive edit,1s 節流 + 4096 防洪),收尾套 HTML 格式;`/new` 重開對話
- 附件：圖片走模型視覺、文件自動進 sandbox(20MB 上限);AI 產出的檔案直接 `sendDocument` 傳回
- **審批按鈕**：HITL 待審動作推播成 批准/拒絕 按鈕(server 端重驗、只執行一次);每日簡報與到期提醒 `/notify_on|off`
- **群組模式**：管理員 `/authorize project|dept <名稱>` 綁定群組;觸發限 @提及/回覆/名字開頭;**發話者要已綁定且是該專案/部門成員**(兩道檢查),以本人身分與權限執行;`/group_context on` 才啟用群組聊天脈絡(記憶體滾動 50 則/30 分,預設看過即丟)
- worker 獨立行程(`npm run worker:telegram`,supervisor script 自動重拉),長輪詢不需對外開 port

### 交接傳承(FR-P-08/09)
- 離職/轉調時把個人 AI 的工作脈絡打包給接手者：工作記憶(history/context,**複製**並標記出處;preference 永不轉)、sandbox 技能(volume 對 volume 複製)、卡片/待辦/未來行程(勾選重新指派)
- 核可：交出者本人簽核;已停用帳號改由第二位管理員 —— **發起人永遠不能自批**;失敗自動回滾(handover_id 反查零殘留)
- 完成自動生成「職位現況報告」(在做什麼/卡點/下一步/慣例/**對外窗口與眉角**/**人事異動通知草稿**),接手者 `/me` 直接看;交接記憶進入接手者 AI 的自動召回,引用時註明「來自 X 的交接」
- 帳號封存：停用即不可登入、AI 停止、Telegram 斷開;sandbox 容器回收、技能 volume 保留;最後一位 admin 受保護
- **知識缺口分析**：建立交接時 AI 比對交出者的活躍工作面(卡片/待辦/行事曆/工具/對話主題)與記憶覆蓋,給出覆蓋度 0–100 與缺口清單,並自動生成**客製訪談題** —— 解掉「把會的都寫下來」只寫得出表面的老問題;交出者在 `/me` 逐題作答,答案直接進交接包
- **問前任**：接手者從 `/me` 或直接請 AI(`askPredecessor` 工具)把答不了的問題送給前任;前任作答自動寫入接手者的交接記憶(標出處);完成後 30 天為追問寬限期,滿月時接手者回報卡點轉為補答問題。**只在前任還在職時轉送**(轉調、離職前過渡期)—— 帳號封存後通道關閉,接手者改看報告與交接記憶
- **Telegram 補答**：未答的訪談/追問題自動推播到前任的 Telegram,「回覆」該訊息即作答、回「略過」跳過,接手者即時收到 Q/A 通知 —— 把「該問的」在**離職前**問好問滿;封存帳號時會提醒還有幾題沒答
- **職位暫存**：還沒找到繼任者時先交給暫管人;正式接手者到職後「二次交接」只轉移原暫存包(記憶/技能/被託管的事項,出處保留原離任者),暫管人自己的工作絕不跟著走

### 今日總覽 dashboard
- 今日事件、到期/逾期待辦、進行中專案、最近對話
- 一鍵 **AI 每日簡報**：綜合行事曆 + 待辦 + 記憶生成

### 主管視角(FR-M lite)
- 團隊工作量表：未完成/已完成待辦、專案參與、最後活動時間
- 主管看自己部門、admin 看全公司;不揭露任何對話內容

### 管理後台
- 公司統一開帳號(無自助註冊)：一次性臨時密碼、首次登入強制改密碼
- 角色/部門管理、密碼重設、部門 CRUD、審計日誌
- 登入暴力破解節流;權限每次請求都查 DB(被降權的 admin 立即失效,不用等 JWT 過期);最後一位 admin 不可自我降權

## 技術棧

| 層 | 選擇 |
|---|---|
| Web | Next.js 16 App Router + React 19 |
| Chat UI | assistant-ui(Base UI 風格 + shadcn) |
| Agent runtime | Vercel AI SDK v5(`streamText` + tools) |
| 驗證 | Zod |
| LLM | 任何 OpenAI 格式 endpoint(`@ai-sdk/openai-compatible`) |
| DB | Postgres 16 + pgvector(Drizzle ORM)— 帳號、對話 JSONB、向量,全在一顆 |
| Auth | Auth.js(NextAuth v5)credentials + JWT |
| Embeddings | transformers.js,本機 CPU,multilingual-e5-small |
| 看板拖曳 | dnd-kit |
| 行事曆 | FullCalendar 6 |
| 可觀測性 | OpenTelemetry → 自架 Langfuse |

## 新成員接手指南

### 0. 需求

- Node.js 20+、Docker(含 compose)
- 一個 OpenAI 格式的 LLM endpoint(base URL + API key + model 名稱)

### 1. 啟動基礎設施

```bash
git clone https://github.com/rlongdragon/hackthone-coworker.git && cd hackthone-coworker
docker compose -f docker-compose.postgres.yml up -d   # 應用 DB(pgvector),host :5433
cp .env.langfuse.example .env.langfuse                # 填入 Langfuse 密鑰(產生方式見檔內註解)
docker compose --env-file .env.langfuse -f docker-compose.langfuse.yml up -d   # LLM 觀測,UI http://localhost:3001
sudo bash scripts/setup-gvisor.sh                     # gVisor runtime(agent sandbox 隔離用)
docker build -t coworker-sandbox:latest sandbox/      # agent sandbox image(文書工具)
```

Langfuse 會依 `.env.langfuse` 自動完成初始化(org / project / admin 帳號 / API key),不用進 UI 手動註冊。

### 2. 設定並啟動應用

```bash
cd web
cp .env.example .env.local   # 填 LLM_* 三個值;LANGFUSE pk/sk 抄 .env.langfuse 的 LANGFUSE_INIT_PROJECT_*
                             # AUTH_SECRET 用 `openssl rand -base64 32` 生一組
npm i                        # 第一次啟動會下載 embedding 模型(約 100MB),之後走快取
npx drizzle-kit push         # 依 db/schema.ts 建表
npm run dev                  # http://localhost:3000
```

### 3. 開第一個帳號

系統沒有自助註冊,第一個 admin 手動塞:

```bash
node -e "console.log(require('bcryptjs').hashSync('你的密碼', 10))"   # 在 web/ 下執行
docker exec -it coworkers-db-1 psql -U coworker -d coworker
```

```sql
INSERT INTO employees (email, name, password_hash, role)
VALUES ('admin@example.com', 'Admin', '<上面的 bcrypt hash>', 'admin');
```

之後所有帳號都從 `/admin` 後台開(含一次性臨時密碼、首次登入強制改密)。

### 3b. 模擬企業(demo / 拍片)

```bash
cd web && npm run seed:demo    # 可重複執行;每次都把 demo 帳號的副作用清乾淨再重建
```

建出財務部(CFO、小明、阿美)+ 業務部(業務主管、小華、小強)、「A 專案」(看板、檔案、9/3 會議記錄、頻道歷史)、「Q3 財務結算」、每人的工作記憶、小明的自架信箱(greenmail,3 封來信)、財務部共用 skill `finance_report`、故意過度授權的 `payroll_export`(給紅隊收緊)。密碼一律 `demo-1234`。
需要:Postgres、greenmail(`docker start coworkers-greenmail`)、LLM gateway;跨部門同意流程要 `.env.local` 設 `AGENT_SOCIETY_CROSS_DEPT_HITL=1`。逐場景拍攝步驟:`w.rlong.me/coworker-demo`。

### 4. 開發慣例

- **改 schema**：編輯 `web/db/schema.ts` → `npx drizzle-kit push`(互動式,需要 TTY)
- **程式碼分層**：`lib/*-store.ts` 純查詢、`lib/*-actions.ts` server actions(含權限檢查)、`lib/agent-tools.ts` AI 工具、`lib/authz.ts` 頁面守門
- **權限原則**：role 一律 DB-fresh 查詢,不信 JWT 內容;新增敏感 AI 工具請走 `lib/approval-store.ts` 的 pending-action 模式
- **觀測**：每輪對話的完整 trace(LLM 呼叫、工具執行、embedding)都在 Langfuse(:3001)
- 常見雷：dev server 必須在 `web/` 目錄下啟動;`.env*` 永不進 git(`.env.example` 除外)

> ⚠️ `docker-compose.langfuse.yml` 不含任何密鑰:SALT / encryption key / API keys / admin 密碼全部來自 `.env.langfuse`(gitignored)。內部服務(postgres / clickhouse / redis / minio)沿用官方 compose 預設密碼,只在 docker 內網;若要對外開放請一併更換。

## 目錄結構

```
web/                    應用本體(Next.js)
  app/                  頁面:/(聊天)/login /chats /admin /manager /tools
                        /projects{,/[id]} /me{,/todos,/calendar,/password}
  app/api/              chat(串流 agent)、approvals(HITL)、events、
                        briefing、projects/[id]/files、files/[id](AI 交付下載)、auth
  lib/                  *-store(查詢)、*-actions(server actions)、
                        agent-tools、approval-store、board-*、file-store、
                        chat-file-store、sandbox、tool-store/tool-runtime、embeddings、authz
  db/schema.ts          19 張表(Drizzle):departments、employees、todos、
                        memories(vector)、conversations、messages、audit_log、
                        projects、project_members、project_files、chat_files、events、
                        event_notes、pending_actions、project_columns、cards、
                        tools、tool_secrets
  components/           assistant-ui thread、approval 卡片、shadcn ui
  instrumentation*.ts   OTel → Langfuse(+ embedding 模型預熱)
docker-compose.*.yml    postgres / langfuse
sandbox/Dockerfile      agent sandbox image(文書處理工具)
scripts/setup-gvisor.sh gVisor runtime 安裝(sandbox 隔離)
```

## 安全設計重點

- 權限判斷一律 DB-fresh,不信任 JWT 內快取的角色
- 所有 UUID / 日期輸入伺服器端驗證;chat id 綁定員工(不可跨帳號竊取)
- 專案文件下載走 memberGate,非成員一律 404;檔名 RFC 5987 編碼
- 專案資料注入 prompt 時包 `<project-data>` 標記,提示模型視為不可信內容
- 敏感操作走 pending-action 狀態機(pending → executing → approved/failed/rejected/expired),原子認領防重複執行
- Agent sandbox 多層防護：gVisor(使用者態 kernel,擋 kernel 逃逸)+ `--network none` + 非 root + `--cap-drop ALL` + memory/cpu/pids 上限;docker 指令一律 execFile 參數陣列(不經 host shell);每條指令進審計日誌
- 工具庫：憑證 AES-256-GCM 加密存,只在 server 端呼叫當下解密注入 header,永不進 sandbox/AI/audit;action 執行前擋 http(s) 以外協定與 cloud metadata endpoint;工具可見性(個人/部門/全公司)於執行時 server 端 re-check,不信 model;敏感 action 走 HITL
- MCP:外部工具描述與回傳皆視為不可信(審核 agent 把描述當資料、回傳框 `<mcp-result>`);投毒審核採確定性掃描守 fail-safe 底線、LLM 只能加嚴;每工具 policy(auto/hitl/blocked)+ 描述 hash pin 防 rug-pull;可見性/enabled/policy 於執行期 re-check;stdio/git/docker 一律 execFile 參數陣列;repo 安裝釘 commit、依賴 `--ignore-scripts`、在 `--network none` gVisor 容器內跑(egress deny 兜底)

# Coworker!

**企業 AI 同事平台**:每位員工一個 AI 代理,代理之間可以互相詢問、委派、派工,但**規則在模型之外強制執行**,而且**被查詢的當事人看得到誰查過自己、被允許還是被拒絕**。全部自架,沒有外部 SaaS。

![主管的代理問下屬的代理:權限交集允許 → 用下屬自己的工作記憶回答,並附來源](docs/img/s1-allowed.jpg)

## 問題與目標

公司導入 AI 之後,通常是每個人各開一個聊天視窗,把資料貼進去問。AI 不知道部門、專案、誰能看什麼;一旦讓多個代理互相協作,權限就只剩 system prompt 裡的一句「不要洩漏」,文獻回報這種 prompt 級防線失敗率 35–51%。被 AI 查詢的員工更是完全不知道自己的資料被誰、以什麼理由讀過。

Coworker! 的目標是把 AI 做成「有名字、有部門、有權限的同事」:代理之間的每一次詢問都經過模型外的**政策執行點(PEP)**,有效權限是雙方權限的**交集**、只會收斂不會放大;每次查詢(包含被拒絕的)都先寫進當事人看得到的**透明帳本**才執行;跨部門要**本人同意**;敏感動作走 **HITL**;系統還會**自我紅隊**,持續攻擊自己的代理並自動收緊。目標使用者是想讓 AI 真正進入組織、又不敢放手的中小企業。

> 摘要(可貼投稿表單,約 160 字):Coworker! 是可完全自架的企業 AI 同事平台。每位員工有自己的代理,代理間可互問、委派、派工;權限在模型外的政策執行點以「權限交集」強制,委派鏈只會收斂。每次跨代理查詢先寫入當事人可見的透明帳本(含被拒絕的查詢)才執行,跨部門需本人同意,寄信、敏感工具走人工確認。內建會議錄音自架語音辨識轉行動項目、團隊代理、專案頻道、信箱,以及會自動收緊權限的自我紅隊。

## 核心功能

- **受治理的委派(A2A)**:`askCoworker` 把問題交給另一位同事的代理當子執行;可用工具 = 兩人權限交集,在工具邊界計算、不寫在 prompt。委派鏈每一跳重算交集,只減不增。
- **當事人透明帳本**:誰的代理、何時、什麼範圍、允許或拒絕、被擋哪些欄位,被查的人在 `/me/ledger` 全部看得到,可匯出 JSON;「不留紀錄就不執行」。
- **敏感個資硬邊界**:`sensitive` / `private` 範圍只有本人可存取,主管、admin、人工審核都沒有例外;模型自報的範圍只能被內容比對往上收緊。
- **跨部門本人同意**:非從屬關係的查詢與派工先停住,當事人在待辦頁按「接受」才執行、才記帳。
- **會議錄音 → 自架 ASR → 行動項目 → 派工**:音檔送自架 GPU 語音辨識,抽出決議與行動項目(標不可信來源),勾選指派負責人;跨部門同樣要本人同意。
- **團隊代理 + 專案頻道**:每個專案一個 `scope=team` 的代理,只看團隊產出(看板、檔案、會議)並附出處;頻道內 `@agent` 召喚,不會提升發話者權限。
- **我的信箱**:員工用自己的 IMAP/SMTP 連接,密碼加密不進模型;來信自動抽行動項目、標不可信;寄信一律本人確認。
- **自我紅隊**:紅隊代理對在線代理發動過度授權、混淆代理人、記憶時間炸彈、MCP 漂移等攻擊;藍隊自動停用工具、隔離記憶;每筆發現可「收緊 / 再跑一次」驗證。
- **基礎能力**:每人獨立 gVisor 沙箱(無網路)執行指令與產檔、三層(個人 / 部門 / 全公司)共用工具庫、外部 MCP 工具接入(投毒審核、auto / hitl / blocked、rug-pull hash pin)、Telegram 頻道、交接傳承、長期記憶(本機 embedding)。

| 敏感查詢被 PEP 擋下,並通知本人 | 當事人帳本:允許 1 / 拒絕 1,被擋欄位 |
|---|---|
| ![](docs/img/s2-denied.jpg) | ![](docs/img/s3-ledger.jpg) |

| 跨部門查詢停住,等本人同意 | 委派鏈:交集移除了對方沒有的工具 |
|---|---|
| ![](docs/img/s4-consent.jpg) | ![](docs/img/s5-chains.jpg) |

| 會議錄音 → ASR → 決議 / 行動項目 → 指派 | 團隊代理只看團隊產出並附依據 |
|---|---|
| ![](docs/img/s6-meeting.jpg) | ![](docs/img/s7-team-agent.jpg) |

| 專案頻道 `@agent` | 信箱:來信標不可信,提示注入不會被照做 |
|---|---|
| ![](docs/img/s8-channel.jpg) | ![](docs/img/s9-mail.jpg) |

| 自我紅隊:發現 → 收緊 → 再跑一次 → defended | MCP 外部工具投毒審核與逐工具政策 |
|---|---|
| ![](docs/img/s10-redteam.jpg) | ![](docs/img/admin-mcp.jpg) |

完整功能說明見 [docs/FEATURES.md](docs/FEATURES.md)。

## 系統架構

```mermaid
flowchart LR
  subgraph clients[使用者端]
    Web[Web UI<br/>Next.js + assistant-ui]
    TG[Telegram bot<br/>grammY worker]
  end
  subgraph app["Coworker! 應用(Next.js 16 App Router)"]
    Agent[Agent runtime<br/>AI SDK v5 streamText + tools]
    PEP[PEP 政策執行點<br/>scope 交集 / 工具交集 / HITL]
    Ledger[透明帳本 + 審計]
    Red[自我紅隊 / 藍隊]
    Emb[Embedding<br/>transformers.js 本機]
  end
  subgraph data[資料]
    PG[(Postgres 16 + pgvector)]
    Files[(專案檔案 / 上傳)]
  end
  subgraph iso[隔離執行]
    SB[Agent sandbox<br/>gVisor, --network none]
    MCP[外部 MCP server<br/>stdio / http,投毒審核]
  end
  subgraph ext[自架外部服務]
    LLM[LLM gateway<br/>OpenAI 格式]
    LF[Langfuse<br/>OpenTelemetry traces]
    ASR[ASR 服務<br/>FunASR, GPU]
    Mail[IMAP / SMTP]
  end
  Web --> Agent
  TG --> Agent
  Agent --> PEP
  PEP --> Ledger --> PG
  PEP --> SB
  PEP --> MCP
  Agent --> LLM
  Agent --> Emb --> PG
  Agent --> PG
  Agent --> Files
  Red --> PEP
  Agent -. OTel .-> LF
  app --> ASR
  app --> Mail
```

- **前端**:Next.js App Router 頁面 + assistant-ui 串流聊天;專案頻道用 SSE 即時同步。
- **後端 / Agent**:Vercel AI SDK v5 `streamText` + 工具;每個工具呼叫在伺服器端重新查 DB 驗證權限(不信 JWT、不信模型)。`lib/pep.ts` 決定 scope 是否允許,`lib/tool-store.ts` 計算工具交集,`lib/delegation.ts` 執行受限子代理。
- **模型**:任何 OpenAI 格式 endpoint(`@ai-sdk/openai-compatible`);embedding 在本機 CPU 用 transformers.js 跑 `multilingual-e5-small`。
- **資料庫**:一顆 Postgres 16 + pgvector 放帳號、對話、記憶向量、帳本、待辦、看板、collab_events。
- **隔離執行**:每位員工一個 gVisor 容器(無網路、非 root、cap-drop、資源上限);MCP 由 repo 安裝的 server 也在 `--network none` 容器內跑。
- **外部服務(皆自架)**:LLM gateway、Langfuse(觀測;用我們的 fork,多了即時時間軸)、FunASR 語音辨識、IMAP/SMTP 信箱。

受治理委派的一次查詢:

```mermaid
sequenceDiagram
  participant M as 主管的代理
  participant P as PEP(模型外)
  participant L as 當事人帳本
  participant S as 小明的代理
  M->>P: askCoworker(小明, scope=project, 問題)
  P->>P: scope 交集 + 內容底線(敏感字詞 → 往上收緊)
  alt 允許
    P->>L: 記錄(允許)
    P->>S: 受限子執行(工具 = 兩人交集)
    S-->>M: 答案 + 來源
  else 拒絕
    P->>L: 記錄(拒絕,被擋欄位)+ 通知本人
    P-->>M: 拒絕(不揭露內容)
  end
```

## 使用技術

| 類型 | 技術／服務 | 用途 |
| --- | --- | --- |
| AI 模型 | 任何 OpenAI 格式 LLM endpoint(demo 用自架 gateway 上的 GPT 系列模型);`Xenova/multilingual-e5-small`(transformers.js,本機) | 對話 / 工具呼叫 / 抽取決議;長期記憶語意召回 |
| 前端 | Next.js 16(App Router)、React 19、assistant-ui、shadcn/ui、Tailwind 4、FullCalendar、dnd-kit | 聊天串流、看板、行事曆、頻道(SSE) |
| 後端 | Vercel AI SDK v5、Auth.js v5、Drizzle ORM、Postgres 16 + pgvector、Zod、OpenTelemetry → Langfuse | Agent runtime、PEP / 帳本 / HITL、資料、觀測 |
| 隔離 / 整合 | Docker + gVisor(runsc)、MCP TypeScript SDK、grammY(Telegram)、imapflow / nodemailer(信箱)、FunASR(自架 ASR) | 沙箱、外部工具、頻道、信箱、會議轉錄 |
| Sponsor 技術 | 無(全部自架、開源元件) | — |

## 安裝與執行

需求:Node.js 20+、Docker(含 compose)、一個 OpenAI 格式的 LLM endpoint(base URL + API key + model 名稱)。gVisor 為選用:沒有的話在 `web/.env.local` 設 `SANDBOX_RUNTIME=runc`,sandbox 改用一般 runc(隔離較弱)。

```bash
git clone https://github.com/rlongdragon/hackthone-coworker.git && cd hackthone-coworker

# 1. 基礎設施
docker compose -f docker-compose.postgres.yml up -d          # 應用 DB(pgvector),host :5433
cp .env.langfuse.example .env.langfuse                        # 填入 Langfuse 密鑰(產生指令見檔內)
docker compose --env-file .env.langfuse -f docker-compose.langfuse.yml up -d   # 觀測平台,UI http://localhost:3001
sudo bash scripts/setup-gvisor.sh                             # (選用)gVisor runtime
docker build -t coworker-sandbox:latest sandbox/              # agent sandbox image

# 2. 應用
cd web
cp .env.example .env.local     # 填 LLM_*;LANGFUSE pk/sk 抄 .env.langfuse;AUTH_SECRET 用 openssl rand -base64 32
npm ci                         # 第一次啟動會下載 embedding 模型(約 100MB)
npx drizzle-kit push           # 依 db/schema.ts 建表(互動式)
docker exec -i coworkers-db-1 psql -U coworker -d coworker < db/agent-society.sql   # 補紅隊 / 記憶出處欄位
docker exec -i coworkers-db-1 psql -U coworker -d coworker < db/a2a-ledger.sql      # 補帳本 / 通知 / collab 欄位
npm run dev                    # http://localhost:3000
```

第一個 admin 帳號手動塞(系統沒有自助註冊):

```bash
node -e "console.log(require('bcryptjs').hashSync('你的密碼', 10))"   # 在 web/ 下執行
docker exec -it coworkers-db-1 psql -U coworker -d coworker \
  -c "INSERT INTO employees (email, name, password_hash, role) VALUES ('admin@example.com', 'Admin', '<bcrypt hash>', 'admin');"
```

之後所有帳號從 `/admin` 開(一次性臨時密碼、首次登入強制改密)。

**一鍵模擬企業(demo 資料)**:

```bash
# demo 信箱伺服器(選用,給「我的信箱」場景)
docker run -d --name coworkers-greenmail -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  greenmail/standalone:2.1.0
cd web && npm run seed:demo    # 財務部 + 業務部 6 個帳號、A 專案、記憶、信件、共用工具;密碼一律 demo-1234
```

跨部門同意流程要在 `.env.local` 設 `AGENT_SOCIETY_CROSS_DEPT_HITL=1`;會議錄音轉錄要設 `ASR_BASE_URL` 指向自架 FunASR 服務(沒有的話可直接貼逐字稿)。

測試:`npm run test`(worker 端 E2E:委派 / 記憶洩漏 / 紅隊 / A2A / 派工 / 信箱 / MCP,需要 DB + LLM)。

## 作品展示

- 作品展示網址(選填):—
- 評選影片:(待補 YouTube 連結)
- 逐場景操作腳本與素材:https://w.rlong.me/coworker-demo

## 限制與未來工作

- **偵測是機率性的**:PEP 在工具邊界強制執行是確定性的,但「這句話是不是敏感」的內容底線和紅隊偵測都依賴模型,定位是「持續偵測 + 縮小爆炸半徑」,不是「解決 prompt injection」。
- **scope 分類目前四級**(project / team / private / sensitive),還沒有到欄位級的資料分類;帳本記的是被擋的欄位類別,不是逐筆資料。
- **自架 ASR 需要 GPU 機**,repo 內只有客戶端;沒有的話只能貼逐字稿。
- **單一 Postgres、單機部署**;沒有做多租戶、SSO、CalDAV 同步(`events.source / external_uid` 已預留)。
- **語音、Telegram 群組摘要、交接傳承**只做到可用,UI 仍偏工程風格。
- 下一步:欄位級分類與差分揭露、紅隊攻擊樣板持續擴充(對接 garak / PyRIT 樣板庫)、帳本的合規匯出格式、企業 SSO。

## 第三方服務、資料與素材

**既有程式揭露**:本作品的基礎平台(個人代理、組織模型、沙箱、工具庫、MCP 接入、Telegram、交接)為團隊在活動前開發的既有程式,以單一 initial import 匯入;黑客松期間新增的是受治理委派 + 自我紅隊、A2A 透明帳本與本人同意、會議 ASR 派工、團隊代理、專案頻道、信箱、demo 模擬企業。

| 項目 | 來源 | 授權 |
| --- | --- | --- |
| Next.js、React、Tailwind CSS、shadcn/ui、assistant-ui、dnd-kit、FullCalendar、zustand、zod、lucide | npm(見 `web/package.json`) | MIT |
| Vercel AI SDK(`ai`、`@ai-sdk/*`)、Drizzle ORM、OpenTelemetry、@huggingface/transformers | npm | Apache-2.0 |
| Auth.js(next-auth v5) | npm | ISC |
| postgres.js、bcryptjs、grammY、imapflow、nodemailer、mailparser、@modelcontextprotocol/sdk | npm | MIT / Unlicense |
| `Xenova/multilingual-e5-small`(embedding 模型) | https://huggingface.co/Xenova/multilingual-e5-small | MIT(原模型 intfloat/multilingual-e5-small,MIT) |
| Postgres 16 + pgvector(`pgvector/pgvector:pg16`) | Docker Hub | PostgreSQL License |
| Langfuse(觀測平台,自架;使用我們的 fork,加上 Logfire 風格即時時間軸) | https://github.com/rlongdragon/langfuse(fork 自 https://github.com/langfuse/langfuse) | MIT(部分 EE 目錄依上游授權) |
| ClickHouse、Redis、MinIO、Postgres 17(Langfuse 相依) | Docker Hub | Apache-2.0 / BSD-3 / AGPL-3.0 / PostgreSQL |
| gVisor(runsc) | https://gvisor.dev | Apache-2.0 |
| sandbox image 內工具:Debian、pandoc、poppler、python(openpyxl、python-docx、python-pptx、pypdf、reportlab、weasyprint)、Node、Noto CJK 字型 | `sandbox/Dockerfile` | 各自授權(GPL / MIT / BSD / OFL) |
| greenmail(demo 信箱伺服器) | https://greenmail-mail-test.github.io/greenmail/ | Apache-2.0 |
| FunASR(自架 ASR 服務,repo 外) | https://github.com/modelscope/FunASR | MIT |
| 紅隊攻擊樣板參考 | PyRIT(MIT)、garak(Apache-2.0)、AgentDojo(MIT) | 僅參考攻擊類型,未複製程式 |
| 研究參考 | AgentLeak、SoK(arXiv 2512.06914)、CaMeL(arXiv 2503.18813)、AgentPoison | 論文 |
| demo 資料 | `web/worker/seed-demo-env.mts` 自行編寫的虛構公司、人物、信件、會議;會議音檔為 TTS 合成語音 | 團隊自製,無真人資料 |
| 影片旁白(如有) | piper TTS(MIT)/ Qwen3-TTS(Apache-2.0)以團隊成員本人聲音合成 | 團隊自製 |

儲存庫內沒有任何 API key、token 或密碼:LLM / Langfuse / 信箱等密鑰全部由 `.env.local`、`.env.langfuse`(皆 gitignored)提供。

## 團隊成員

| 姓名 | 分工 |
| --- | --- |
| rlongdragon | 架構、Agent runtime、PEP / 帳本、紅隊、demo |
|  |  |

## License

MIT — 見儲存庫根目錄 [LICENSE](LICENSE)。

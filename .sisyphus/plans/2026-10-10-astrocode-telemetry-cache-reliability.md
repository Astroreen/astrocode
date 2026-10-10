# astrocode — Telemetry & Budget, Cache-Safe Compaction, Tool Reliability (workstreams A–I)

## TL;DR

- **9 workstreams from handoff** (A телеметрия/бюджет, B алиасы tool-имён, C DCP off, D compaction engine, E determinism system-слоя, F schema hygiene, G thinking policy, H fallback observability, I cleanup remapping) в порядке A→B→C→E→D→G→H→F→I.
- **Ключевые архитектурные решения** (owner-approved): DCP off **везде** (не только anthropic); compaction engine — rule-triggered, epoch-based, **без model-visible compress tool**; алиасы — soft-redirect + точечные реальные side-effects через SDK client (переопределять `task` запрещено).
- **17 work items (T1–T17) в 5 waves** + Final Wave. Каждый item: references / implementation / acceptance / QA (happy+failure) / commit message.
- Верификация: cache ratio ≥ 0.95 на 2-дневном cheap-run и на Claude+meridian-run (сверка с OpenRouter-билингом ±10%), живой тест алиасов, schema-diff, compaction retry/hash-guard, system determinism diff, budget block.
- Коммиты — только по явной просьбе пользователя (глобальное правило). Сообщения коммитов подготовлены в каждом item.

## Context

### Original Request (user verbatim, authoritative)

> I want you to create a plan for astrocode plugin to improve it futher. Here are the handoff with ideas and context from another agent conversation: [полный текст handoff — см. ниже]. The plan was made on NixOS host (you can access it using ssh via tailnet, it is named `server` with astroreen username) or you can find the same nixos configuration on github: https://github.com/Astroreen/NixOS-dotfiles.

Приложенный handoff (полный текст в исходном сообщении пользователя; копия на сервере: `/home/astroreen/reports/Handoff astrocode plugin.md`) — **authoritative spec**. Его обязательства:

- **Миссия (приоритет):** (1) телеметрия и бюджет — без замеров остальное вслепую; (2) cache hit ~99% — компакция и system prompt не должны ломать префиксный кэш Anthropic; (3) надёжные tool calls — алиасы против галлюцинаций (`Task_Create` и т.п.), устранение retry-петель компакции.
- **Scope:** всё, что возможно через opencode plugin system — in scope. Реализация — в плагине astrocode (source repo `Astroreen/astrocode`, деплой через NixOS activation копированием).
- **Верификация (handoff §8):** кэш-замер со сверкой билинга ±10%; живая сессия Claude через meridian «вызови Task_Create» → исполняется как task; дифф tool schema; compaction: wrong-format summary → ровно 1 retry → deterministic fallback, повторный компакт не меняет байты; system prompt дифф между запросами = пусто; бюджет: лимит → tool call блокируется + уведомление.
- **Жёсткие ограничения (handoff §7):** никаких `as any` / `@ts-ignore` / `@ts-expect-error`; пустые catch-блоки запрещены; изменения в source repo `Astroreen/astrocode`; НЕ патчить файлы в `.cache/opencode/packages/` (vendor-патч — только через NixOS-копирование паттерном `.astrocode-src`); коммиты только по явной просьбе пользователя.

### Owner Decisions (Q&A, verbatim answers)

1. **Q:** «Когда compaction engine (D) заработает — что делать с DCP на cheap-пути (OpenRouter)?» — options: «DCP off везде (Recommended)» / «DCP off только для anthropic (как в handoff)».
   **A:** `DCP off везде (Recommended)`.
   Следствие: acceptance «openrouter — compress присутствует» из handoff **заменяется** — `compress` отсутствует в tool schema на всех путях; DCP убирается из plugin list целиком; наш engine — единственный мутатор контекста.
2. **Q:** (approval gate) план к записи в `.sisyphus/plans/`?
   **A:** `ok` (2026-10-10).

### Planner Decisions (applied defaults — technical, not owner; executor НЕ пере-выводит)

1. **Спайк 1 (usage-поля) решён:** `AssistantMessage` из SDK: `{cost, tokens: {input, output, reasoning, cache: {read, write}}, modelID, providerID, error?, time: {created, completed?}}`. Логировать из `message.updated` → `properties.info`. Cache ratio = `cache.read / (cache.read + cache.write + input)`; при нулевом знаменателе = 1.0.
2. **Спайк 2 (hook load-order astrocode vs DCP) снят с повестки:** DCP off везде → гонки конфиг-хуков не существует. Механика per-agent `tools` map остаётся в Ground Truth как общая capability.
3. **Спайк 3 (мутация истории) решён:** прямого API мутации persistent storage у плагина НЕТ. Доступное: `experimental.chat.messages.transform` (мутация истории на request-build; persistent storage не трогается), `experimental.session.compacting` (замена prompt компакции), `POST /session/{id}/summarize` (нативная компакция; body `{providerID, modelID}` — отдельная модель-суммаризатор), event `session.compacted`, `tool.execute.after` (мутация output тула до показа модели). Дизайн D строится на этом.
4. **Модель кэша — «cache epoch»:** между компакциями байты истории, уже уходившие в API, **неизменны** (append-only новые ходы). Компакция = один осознанный epoch break (1 accept-able cache miss). После — новый префикс кэшируется заново. Любая мутация старых байтов вне epoch break запрещена. Это сводит доктрины «immutable prefix» и «one compaction = one miss» в единое правило.
5. **Алиасы — физика делегирования:** tool-execution API не существует (в `ToolContext` нет client; в SDK routes нет exec). Механизм: **soft-redirect** (алиас возвращает успешный tool result с каноничным вызовом; максимум 1 hop; без error-part) + **реальные side-effects через `PluginInput.client`** там, где тривиально (`TaskStop`→session abort, `TaskOutput`→чтение messages ребёнка). **Переопределять `task` своим execute ЗАПРЕЩЕНО** — обойдёт патч `opencode-task-fallback.patch` (settleChild/evaluateChild).
6. **D без model-visible compress tool:** триггер компакции — правила (ratio контекста + граница хода/`session.idle`), не решение модели. Tools-схема не меняется в течение сессии → префикс кэша стабилен. Ручной триггер — slash-команда `/astrocode:compact`.
7. **Workstream I дешевле, чем в handoff:** runtime-переписывания текста модели в коде НЕТ (проверено grep'ом и локально, и в `.astrocode-src` на сервере). «Remapping» = (а) HTML-comment compat-таблицы внутри template-строк команд (уезжают в модель, жгут токены, провоцируют модель «исправлять» имена в code blocks), (б) remap-инструкции «X → Y» в prompt-секциях. I = вычистить model-visible remap-текст, археологию перенести в JS-комментарии.
8. **Суммаризатор D:** PRIMARY — нативный `POST /session/{id}/summarize` c `{providerID, modelID}`; **probe верифицирует**, что модель реально применена (по телеметрии). FALLBACK (если model override игнорируется/route семантика иная) — scratch-session суммаризатор: прочитать историю через `client.session.messages`, создать дочернюю сессию с дешёвой моделью через `client.session.create` + `client.session.prompt`, вернуть summary text, вставить как frozen summary block через `experimental.chat.messages.transform`.
9. **Телеметрия — JSONL в XDG state:** `~/.local/state/astrocode/telemetry/telemetry-YYYY-MM-DD.jsonl`, override env `ASTROCODE_TELEMETRY_DIR`. Все подсистемы пишут в один sink.
10. **Feature flags в astrocode.jsonc на каждую подсистему** (telemetry/budget/aliases/compaction/reasoning_overrides/schema_validator) — rollback = flip флага, не code revert.

### Ground Truth (verified firsthand — do not re-derive)

**Раскладка:**

| Что | Где |
|---|---|
| workspace (git clone `Astroreen/astrocode`, origin github) | `/home/ilja/Documents/astrocode` |
| entry + хуки | `src/index.ts` (624 строки: event/message.updated/message.part.updated/session.status/chat.message/experimental.chat.system.transform/chat.params/**config**) |
| config parse | `src/config/astrocode.ts` (395 строк; `parseFallbackConfig`, `asNonNegativeInt`) |
| команды | `src/commands/index.ts` (819 строк; `buildBuiltinCommands()`; HTML-comment compat-таблицы в template-строках ~347–349 и ~632–634; header 4–8 — porting-заметки remap) |
| reasoning | `src/models/tuning.ts` (`CLAUDE_THINKING_BUDGET_TOKENS=32000`, `REASONING_LEVELS`, `splitReasoningSuffix`, `reasoningConfigForFamily`: claude→thinking{enabled,budgetTokens}, gpt→reasoningEffort, grok/minimax/other→{}) |
| fallback | `src/fallback/{config,state,session-model,classify,canonicalize,index,subagent}.ts` (cooldown_seconds=60 global; retry-key dedup; pin/touch session model; subagent с parentID — отдельная ветка) |
| промпты | `src/prompts/sisyphus/{sections.ts,families/*}` + `src/prompts/{dump,guards}.ts` |
| тесты | `test/` (20 файлов); scripts: `bun test`, `bun run typecheck` (`tsc --noEmit`) |
| docs | `docs/{fallback-spike-findings,spike-findings,porting-plan,oh-my-parity,plugin-test-prompt}.md` |
| spike-скрипты | `spike/probe-system-transform.js` (паттерн для новых проб) |
| планы-шаблоны | `.sisyphus/plans/2026-09-25-fallback-subagent-family-fixes.md` (структура этого плана) |
| learnings | `.sisyphus/notepads/astrocode-plugin/learnings.md` |
| deploy-источник конфига | `/home/astroreen/.local/share/nixos/home/astroreen/profiles/terminal/ai/opencode/astrocode.jsonc` (NixOS activation копирует) |
| NixOS repo на сервере | `/home/astroreen/.local/share/nixos` (`meridian.nix` — systemd user service :3456; `opencode/default.nix` — activation copy; `opencode-task-fallback.patch` — settleChild/evaluateChild) |
| plugin entry на сервере | `/home/astroreen/.config/opencode/plugins/astrocode.ts` = symlink → `.astrocode-src/src/index.ts`; `.astrocode-src` = копия flake input |
| global config на сервере | `/home/astroreen/.config/opencode/opencode.json`: plugins = [meridian.ts, md-table-formatter, notifier, **opencode-dcp**, anthropic-auth, claude-auth]; astrocode НЕ в массиве (auto-discovery `~/.config/opencode/plugins/` + per-project `.opencode/`); `provider.anthropic.options.baseURL = http://127.0.0.1:3456` (meridian) |
| dcp.jsonc | только `$schema`, пустой config |
| SSH | `astroreen@server` (tailnet) работает |

**Plugin API (`@opencode-ai/plugin`) — используемые хуки:**

- `config` — мутация opencode config (персонажи→agents, model cascade, reasoning, команды).
- `tool: {name: tool({description, args: ZodRawShape, execute(args, ctx)})}` — plugin tool **выигрывает name collision** (верифицировать живьём при T5). `ToolContext = {sessionID, messageID, agent, directory, worktree, abort, metadata(), ask()}` — **без client и без tool-exec**. `PluginInput.client` — `createOpencodeClient`, захватывается в closure.
- `tool.execute.before` (in: {tool, sessionID, callID}; out: {args}) — мутация args, **throw блокирует вызов** (единственная точка enforcement бюджета).
- `tool.execute.after` (out: {title, output, metadata}) — мутация output тула.
- `tool.definition` (in: {toolID}; out: {description, parameters}) — перезапись description/parameters тулов, уходящих в LLM (механизм F).
- `experimental.chat.system.transform` (out: {system: string[]}) — **приходит pre-filled** (mutate-in-place; замена = length=0+push); тело `.md` агента уже встроено; `input.model.modelID` может быть null → использовать `input.model.id`; хуки горят и для subagents.
- `experimental.chat.messages.transform` (out: {messages: {info: Message, parts: Part[]}[]}) — мутация истории на request-build.
- `experimental.session.compacting` (in: {sessionID}; out: {context: string[], prompt?: string}) — замена prompt компакции.
- `chat.params` (out: {temperature, topP, topK, options}) — reasoning-инжект; `chat.message`, `chat.headers`, `event`, `permission.ask`, `command.execute.before`, `shell.env`, `auth`.

**SDK routes (`@opencode-ai/sdk`):**

- `POST /session/{id}/summarize` body `{providerID, modelID}` → 200 boolean.
- `GET /session/{id}/todo` (read-only), `POST /session/{id}/prompt_async` (parts; model override), `GET /session/{id}/message/{messageID}`.
- `/experimental/tool`, `/experimental/tool/ids` — **только list, exec-роута нет**.
- TUI `executeCommand` (freeform: `"session.compact"` и т.п.).
- Events: `message.updated`, `message.part.updated`, `session.compacted`, `session.status`, `session.idle`, `session.error`, `todo.updated`.
- Тип `CompactionPart` существует.

**DCP (`@tarquinen/opencode-dcp@3.1.6`)** — выключаем целиком; факты для понимания рисков: `tool: {compress}` + `config` hook + `experimental.chat.messages.transform` pipeline (stripHallucinations/prune/syncCompressionBlocks/injectCompressNudges/…); config-хук не перезаписывает явный permission; **нет** schema-validation вывода, **нет** retry-cапа, **нет** per-provider enable.

**meridian (npm `@rynfar/meridian`, minified dist):**

- Стоит ТОЛЬКО на anthropic-пути (cheap → OpenRouter напрямую).
- `BLOCKED_BUILTIN_TOOLS` = [Read, Write, Edit, MultiEdit, Bash, Glob, Grep, NotebookEdit, WebFetch, WebSearch, **TodoWrite**]; `CLAUDE_CODE_ONLY_TOOLS` = [CronCreate…, EnterPlanMode, ExitPlanMode, NotebookEdit, TodoWrite, AskUserQuestion, Skill, Agent, TaskOutput, TaskStop, WebSearch].
- Passthrough MCP (`mcp__oc__*`) регистрирует opencode-тулы; non-passthrough режим — `mcp__opencode__*`.
- `updatedInput` переписывает **только tool input** (fuzzyMatchAgentName для `Task`), **никогда имя тула** → алиасы должны быть реальными тулами.
- Preset `claude_code` рекламирует словарь Claude Code (TaskCreate/TaskUpdate/TodoWrite) — источник галлюцинаций; реальный registry = task/todowrite + passthrough.

**Learnings-готчи (из notepad; действуют):**

- Write/Edit sanitizer может превратить `const x = <call|member|new>` в `__POTENTIAL_IDENTIFIER_ASSIGNMENT_*__` placeholder'ы — **проверять содержимое файлов после записи** (прочитать назад).
- Frontmatter `tools` агентов обязан быть `Record<string, boolean>` (список роняет opencode).
- `--agent explore` не может быть primary agent.
- Headless QA паттерн: `opencode run --auto -m <model>` + изоляция через `XDG_CONFIG_HOME`.
- Free-tier opencode models требуют CLI ≥ 1.18.

**Конфиг astrocode.jsonc (deploy-источник):** global model `anthropic/claude-sonnet-5-5`; 12 агентов с model+fallback_models цепями (Sonnet→Haiku→openrouter/xiaomi/mimo-v2.6-pro → z-ai/glm-5.3-flash → qwen3.8-flash → deepseek-v4.1-flash → gpt-6-luna → … → openrouter/free); TRAPS-список в комментариях (qwen3-coder-next и пр. — не возвращать); gotchas resolveFamily (substring) и canonicalize dedup.

## Scope / Must-NOT-Have

### Scope

- Код: только source repo `Astroreen/astrocode` (workspace `/home/ilja/Documents/astrocode`).
- Deploy-config (отдельные явные пункты, минимальные): NixOS repo `/home/astroreen/.local/share/nixos` — убрать `@tarquinen/opencode-dcp` из plugin list (opencode.json deploy source), опционально dcp.jsonc → `compress.permission: "deny"` (страховка на случай возврата DCP).
- Новые тесты в `test/`, новые spike-пробы в `spike/`, evidence в `.sisyphus/evidence/2026-10-10-astrocode-telemetry-cache-reliability/`.

### Must-NOT-Have (guardrails — violation = план провален)

1. **vibeguard — мёртв, пользователь отказался навсегда. Не предлагать ни в каком виде, ни в коде, ни в доках, ни в follow-up.**
2. Никаких патчей meridian (upstream-parallel только упоминанием, см. ниже). Preset `claude_code` не трогать (ломает Max disguise/билинг).
3. Никаких `as any` / `@ts-ignore` / `@ts-expect-error`. Пустые catch-блоки запрещены (каждый catch логирует через `src/log.ts` facade).
4. Не патчить файлы в `.cache/opencode/packages/` и `node_modules/` — теряется при обновлении.
5. **Не переопределять `task` (и прочие builtin'ы) plugin-тулами с собственной реализацией** — обход settleChild/evaluateChild патча.
6. **Никакого model-visible compress/compaction tool** в tools-схеме.
7. Никакой динамики (timestamp/session-id/счётчики) в system prompt и tool schemas в течение сессии; никаких мутаций уже отправленных байтов вне epoch break; никакой повторной перегенерации summary сжатых регионов.
8. Никаких неограниченных retry-циклов (ровно 1 retry → deterministic fallback). Никакого forced `tool_choice: any/tool` (400 на Sonnet 5.5/Opus 5.5/Fable 5.1).
9. Коммиты — только по явной просьбе пользователя (сообщения в плане подготовлены, git commit НЕ выполнять без запроса).
10. Миграция на pi coding agent — вне плана. Удаление meridian preset `claude_code` — запрещено.

### Upstream-parallel (упомянуть в README/learnings, НЕ реализовывать)

- PR в meridian: fuzzyMatchToolName на parse-слое (переименование tool-имён до рантайма).
- PR в meridian: убрать TaskCreate/TaskUpdate/TodoWrite из словаря preset `claude_code` (или привести к реальному registry).
- Конфиг (не плагин): `MERIDIAN_BETA_POLICY=allow-all` в `meridian.nix` — без него extended-cache-ttl 1h на claude-max недоступен (вырезание billable-бет = 3x TTFB и 3x токены на длинных сессиях; meridian issue #278). Упомянуть в T17 отчёте как рекомендацию, правка — отдельным решением пользователя.

## Work Items

Формат каждого: **Goal / References / Implementation / Acceptance / QA (happy + failure, exact invocations, evidence path) / Commit**. Evidence root: `.sisyphus/evidence/2026-10-10-astrocode-telemetry-cache-reliability/T<n>/`. Все пути относительно `/home/ilja/Documents/astrocode`, если не указано иное.

### Wave 1 — Telemetry foundation (workstream A; параллельно внутри волны)

#### T1. `src/telemetry/` — JSONL sink + usage capture

**Goal:** per-request лог usage (все поля из Ground Truth «Спайк 1»), единый sink для остальных подсистем.

**References:**
- `src/index.ts` — хук `message.updated` (существующий, fallback-dispatch на `info.error`) — расширить, не ломать существующую логику.
- `src/log.ts` — facade для ошибок записи.
- `src/config/astrocode.ts` — место для новых config-полей + parse-функции.
- SDK `AssistantMessage` (Ground Truth).

**Implementation:**
1. Новый модуль `src/telemetry/log.ts`: `TelemetryLogger` (interface: `record(kind, payload): void`, `close(): void`). Запись — append-only JSONL в `${ASTROCODE_TELEMETRY_DIR ?? XDG_STATE_HOME ?? ~/.local/state}/astrocode/telemetry/telemetry-YYYY-MM-DD.jsonl`. Ротация по дате (новый файл при смене дня, проверка при записи). Ошибки записи/создания dir → `log.error` (не молча). Async write батчами (накопить ≤ 50 записей или 2 сек flush; `queueMicrotask`/`setTimeout` — без держания event loop: `unref()` таймер).
2. Record shape (строго, snake_case поля):
   ```ts
   type TelemetryRecord = {
     ts: string;              // ISO 8601
     kind: "usage" | "fallback" | "compaction" | "tool_error" | "budget_block" | "schema_violation" | "system_diff" | "alias_hit" | "cache_alarm";
     session_id: string;
     message_id?: string;
     agent?: string;
     model?: { provider_id: string; model_id: string };
     tokens?: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number };
     cost_usd?: number;
     cache_ratio?: number;
     event?: Record<string, string | number | boolean | null>;
   };
   ```
   Пустой `catch` запрещён; неизвестные поля в payload не пишем (валидируем на входе parse-функцией без `as any`).
3. В `src/index.ts` хук `message.updated`: если `info.role === "assistant"` → запись `kind:"usage"` (tokens/cost/model/ids). `cache_ratio` = формула из Planner Decisions #1. При `cache_ratio < 0.95` и `input+cache_read+cache_write > 10000` → дополнительная запись `kind:"cache_alarm"`.
4. Config: `telemetry: { enabled: boolean; dir?: string }` в astrocode.jsonc; parse в `src/config/astrocode.ts` (та же дисциплина, что `parseFallbackConfig`). `enabled:false` → полный no-op (ни одного I/O).
5. Тест `test/telemetry.test.ts`: record→file roundtrip; ротация по дате; cache_ratio формула (вкл. знаменатель 0); cache_alarm порог; enabled:false = no-op.

**Acceptance:**
- Каждый assistant-ответ в сессии даёт ровно одну usage-запись с полным набором полей (tokens/cost/model).
- `cache_ratio` валиден; `cache_alarm` срабатывает при < 0.95 на крупных запросах.
- Ничего не пишется при `telemetry.enabled=false`.

**QA:**
- Happy: `bun test test/telemetry.test.ts && bun run typecheck` → green; затем headless: `XDG_CONFIG_HOME=/tmp/opencode-qa-t1 opencode run --auto -m openrouter/xiaomi/mimo-v2.6-pro "say hi"` → проверить `~/.local/state/astrocode/telemetry/telemetry-<today>.jsonl` содержит usage-запись с model `openrouter/xiaomi/mimo-v2.6-pro`. Evidence: `T1/usage-sample.jsonl`.
- Failure: сломать путь (dir = `/proc/1/x`) → в логах `[astrocode]` error о записи, сессия НЕ падает. Evidence: `T1/write-failure.log`.
- Визуально проверить содержимое созданных файлов (sanitizer-готча).

**Commit:** `feat(telemetry): JSONL usage logger with cache ratio + alarm` (выполнять только по явной просьбе).

#### T2. Budget enforcement (`tool.execute.before`)

**Goal:** per-session и per-agent spend-cap; превышение блокирует tool call + уведомление.

**References:**
- `src/index.ts` — существующий `tool.execute.before` (если отсутствует — добавить к хукам).
- `src/log.ts` — `Toast` (уведомление без внешних зависимостей; notifier-плагин не трогаем).
- T1 (`TelemetryLogger`, агрегаты).

**Implementation:**
1. Модуль `src/telemetry/budget.ts`: in-memory агрегаты `Map<sessionID, {total_usd, by_agent: Map<string, number>}>`, обновление из usage-записей T1.
2. Config: `budget: { enabled: boolean; session_usd?: number; agent_usd?: number }` (оба опциональны; `undefined` = не ограничивать; `0` = блокировать всё; parse с `asNonNegativeNumber`).
3. В `tool.execute.before`: если budget enabled и (`session total ≥ session_usd` или `agent total ≥ agent_usd`) → запись `kind:"budget_block"` + `toast` + **throw Error** с текстом `astrocode budget exceeded: session spend $X.XX ≥ $Y.YY limit (agent: N)` — throw блокирует вызов (единственная точка enforcement; между tool calls — осознанное ограничение, документируется в README).
4. Тест `test/budget.test.ts`: агрегация; блокировка при превышении session/agent; не блокирует при disabled; не блокирует при не-превышении; Error message содержит цифры.

**Acceptance:**
- Фиксированный лимит (`session_usd: 0.01`) → tool call блокируется, модель получает error с суммами, бюджет_block event + toast в логах.
- Уведомление приходит (toast записан в log facade; evidence содержит его).

**QA:**
- Happy: `bun test test/budget.test.ts` → green.
- Failure/integration: headless сессия с `budget.session_usd=0.001` в конфиге, промпт «list files with the bash tool» → tool call отклонён, в JSONL `budget_block`, в stdout `[astrocode]` toast. Evidence: `T2/budget-block.log` + `T2/budget-block.jsonl`.

**Commit:** `feat(telemetry): per-session/per-agent spend cap enforcement` (только по явной просьбе).

#### T3. Event sinks: fallback / compaction / tool_error

**Goal:** единый канал событий для H/D/F/A: kind-специфичные payload'ы + helper `recordEvent()`.

**References:** T1 (`src/telemetry/log.ts`), `src/fallback/index.ts` (точки logDecision/toast), `src/index.ts` (`message.part.updated` — retry dedup).

**Implementation:**
1. В `src/telemetry/log.ts` добавить типизированные helper'ы: `recordFallback(...)`, `recordCompaction(...)`, `recordToolError(...)`, `recordAliasHit(...)`, `recordSystemDiff(...)` — каждый валидирует payload и пишет свой `event`-под-объект. Схемы `event` для каждого kind фиксированы в типах (детали — в T11/T14/T15/T5/T8).
2. Точка `tool_error`: `message.part.updated` — part типа tool с `state.status === "error"` → `recordToolError` (tool name, error text ≤ 500 символов).
3. Тест `test/telemetry.test.ts` расширить: каждый helper пишет валидный record.

**Acceptance:** каждый из 3 событий создаёт валидную JSONL-запись; существующая fallback-логика не сломана (`bun test` зелёный).

**QA:**
- Happy: `bun test test/telemetry.test.ts` → green.
- Failure: helper с невалидным payload (например, отсутствует tool name) → `log.error`, запись не портит JSONL (валидный JSON на каждой строке). Evidence: `T3/invalid-payload.log`.

**Commit:** `feat(telemetry): typed event sinks for fallback/compaction/tool_error` (только по явной просьбе).

### Wave 2 — Tool reliability + статические поверхности (B, C, E; после Wave 1, параллельно внутри волны)

#### T4. B0 spike: reachability алиасов через meridian (decision tree)

**Goal:** определить, доходит ли bare `Task_Create`/`TodoWrite` до opencode tool registry на Claude+meridian пути.

**References:** Ground Truth (meridian BLOCKED_BUILTIN_TOOLS / passthrough / preset claude_code); `spike/probe-system-transform.js` (паттерн probe-скрипта); сервер: `astroreen@server`, meridian systemd user service :3456.

**Implementation:**
1. `spike/probe-alias-reach.ts` (запускать через `bun`): поднять минимальный opencode-конфиг с plugin-пробником (регистрирует тул `Task_Create`, execute пишет маркер в файл) + provider.anthropic → `http://127.0.0.1:3456`; headless сессия с промптом «вызови инструмент Task_Create с аргументами {description: "probe"}».
2. Замеры: (а) выполнился ли execute маркера; (б) какое имя пришло (bare / `mcp__oc__Task_Create` / иное) — пишем в marker-файл `tool` из `tool.execute.before`; (в) не появилось ли native-SDK выполнение (по отсутствию маркера при «успехе» модели).
3. Повторить для `TodoWrite` (в BLOCKED_BUILTIN_TOOLS — ожидается passthrough-маршрут) и для `Agent`.
4. Deployment под тест: изоляция `XDG_CONFIG_HOME=/tmp/opencode-qa-b0` на **сервере** (там живёт meridian), plugin-пробник туда же; убедиться, что meridian service активен (`systemctl --user status meridian`).

**Decision tree (executor выполняет ОБЕ ветки документации, код — по факту):**
- **Outcome A (маркер сработал, имя = bare/aliased):** алиасы реальны → T5/T6 как запланировано; в acceptance B фиксируем путь.
- **Outcome B (маркер НЕ сработал — вызов ушёл в native Claude Code SDK или ошибка до registry):** алиасы на meridian-пути не перехватываются. Митигейшн: (1) усиленный system-guard каноничных имён (T8) — основная защита; (2) алиасы всё равно регистрируем для cheap-пути и для случаев passthrough-имён; (3) в acceptance G2 меряем «0 native-SDK TaskCreate выполнений» вместо «executed as task» на meridian-пути; для cheap-пути acceptance остаётся полным. Записать найденное в `.sisyphus/notepads/astrocode-plugin/learnings.md`.
- В обоих исходах T5/T6 выполняются (алиасы нужны как safety net минимум на cheap-пути).

**Acceptance:** probe-отчёт `T4/report.md` фиксирует исход A/B с логами маркеров для Task_Create/TodoWrite/Agent.

**QA:**
- Happy: запуск пробы, evidence `T4/marker-*.log` + `T4/report.md`.
- Failure: meridian недоступен (service down) → проба честно падает с понятной ошибкой (не hang), report фиксирует «probe inconclusive: meridian unreachable». Evidence: `T4/meridian-down.log`.

**Commit:** `chore(spike): alias reachability probe for meridian path` (только по явной просьбе).

#### T5. `src/aliases/` — registry алиасов + soft-redirect execute

**Goal:** галлюцинированные имена исполняются без error и без петель; каноничные тулы вызываются ровно один раз следующим ходом модели.

**References:** T4 (исход), T3 (`recordAliasHit`), `src/index.ts` (экспорт `tool:` добавить; config hook — статичность набора), Ground Truth (Plugin API `tool()`; «plugin wins collision» — верифицировать).

**Implementation:**
1. `src/aliases/registry.ts` — константный массив `AliasDefinition {alias, canonical, kind: "redirect" | "delegate", description}`. **Первый состав (фиксированный; расширение — правкой константы, НЕ динамически в сессии):**
   | alias | canonical | kind |
   |---|---|---|
   | `Task_Create`, `TaskCreate`, `Task_Update`, `TaskUpdate`, `Task_Get`, `TaskGet`, `Task_List`, `TaskList` | `todowrite` (+ `todoread` для Get/List) | redirect |
   | `TodoWrite` | `todowrite` | redirect |
   | `TodoRead` | `todoread` | redirect |
   | `TaskOutput` | (чтение messages ребёнка) | delegate (T6) |
   | `TaskStop` | (abort ребёнка) | delegate (T6) |
   | `Agent` | `task` | redirect |
   | `Skill` | каноничный skill-loader (имя уточнить через `/experimental/tool` list на момент реализации; ожидается `skill`) | redirect |
   | `EnterPlanMode`, `ExitPlanMode` | `task(subagent_type="prometheus")` (конвенция из `commands/index.ts` header) | redirect |
2. `src/aliases/index.ts` — `buildAliasTools(client)`: для каждого alias → `tool({description, args, execute})`:
   - description строго: `DEPRECATED ALIAS of \`${canonical}\`. Do not call this tool. Call \`${canonical}\` with your intended arguments instead. This alias exists only as a compatibility shim.` (описание обязательно — модель его учитывает).
   - args: loose Zod-объект (`z.record(z.string(), z.unknown())` через `z.object({}).passthrough()` — Zod v3; без `as any`).
   - execute (kind redirect): `recordAliasHit(...)` + вернуть строку-результат: `` Called via deprecated alias `${alias}`. This harness has no such tool. Execute now: call `${canonical}` exactly once with your intended arguments. Do not retry this alias. `` + JSON-эхо полученных args. Всегда успешный результат (не throw) — без error-part, максимум 1 hop.
3. Экспорт `tool:` в `src/index.ts` — spread `buildAliasTools(...)` (client из PluginInput closure). Набор алиасов статичен на весь bootstrap (cache-префикс стабилен; знакомство schema — однократное).
4. Config: `aliases: { enabled: boolean }` (default true) — disabled = не регистрировать.
5. Верификация name collision (plugin tool vs builtin): живая сессия — если наш `TodoWrite` перехватывает вызов (expected), фиксируем; если builtin побеждает — записать в learnings и в T4-отчёт (на поведение redirect это не влияет: цель — отсутствие «unknown tool»).
6. Тест `test/aliases.test.ts`: snapshot состава registry (точный список имён); execute redirect возвращает каноничное имя в тексте и не бросает; description содержит `Do not call`.

**Acceptance:**
- Сессия на cheap-модели: вызов `Task_Create` (провокация промптом) → успешный tool result с redirect-текстом, следующим ходом вызван `todowrite` (или `task`) ровно один раз; в логах 0 «unknown tool».
- Набор tools-схемы статичен в течение сессии (хэш schema одинаков между запросами — замер T8-инструментом).

**QA:**
- Happy: `bun test test/aliases.test.ts && bun run typecheck` → green; headless `XDG_CONFIG_HOME=/tmp/opencode-qa-t5 opencode run --auto -m openrouter/xiaomi/mimo-v2.6-pro "вызови инструмент Task_Create с description 'probe' затем сделай что он предлагает"` → в JSONL `alias_hit`, далее canonical-вызов, 0 error-parts. Evidence: `T5/alias-redirect.jsonl` + `T5/transcript.md`.
- Failure: провокация неизвестным именем `FooBar_Baz` (не в registry) → opencode отвечает unknown tool (это ОК), наш alias-слой не падает, сессия живёт. Evidence: `T5/unknown-tool.log`.
- На Claude+meridian пути — сценарий G2 (после T4-решения дерева): промпт «вызови Task_Create» → либо redirect, либо (Outcome B) 0 native-выполнений + guard-поведение. Evidence: `T5/meridian-alias.md`.

**Commit:** `feat(aliases): deprecated tool-alias shims with soft redirect` (только по явной просьбе).

#### T6. Реальные side-effects: `TaskStop` / `TaskOutput`

**Goal:** там, где SDK позволяет реальное действие — сделать его вместо redirect.

**References:** Ground Truth (SDK routes; `PluginInput.client`), T5 (registry kind:"delegate"), T4 (исход).

**Implementation:**
1. `TaskStop` execute: найти дочерние сессии (через client API children/sessions list — роут уточнить по SDK types на месте; если list-роута нет → fallback: принять `session_id` в args) → `client.session.abort(childID)` (или TUI-команда abort через `client.tui.executeCommand({command: "session.abort"})` — выбрать доступное, верифицировать на месте) → результат: `Stopped session <id>.` При недоступности API — вернуть redirect-текст (не падать).
2. `TaskOutput` execute: `client.session.messages(childID)` → вернуть текстовую выжимку последних assistant-сообщений (≤ 2000 символов, обрезка с маркером). При отсутствии child list — redirect.
3. Оба пишут `recordAliasHit(kind:"delegate")`.
4. Тест `test/aliases.test.ts`: мок client (interface-обёртка, jest-стиль mock без `as any`) — delegate-ветки; fallback-ветки при отсутствии API.

**Acceptance:** на cheap-пути `TaskStop` реально останавливает (или честно redirect при недоступности API — вердикт фиксируется в evidence), `TaskOutput` возвращает реальный текст или redirect; ни одного throw.

**QA:**
- Happy: `bun test test/aliases.test.ts` → green; headless-сессия с делегацией task + провокация `TaskOutput` → получен текст/redirect. Evidence: `T6/task-output.md`.
- Failure: `TaskStop` с несуществующим session_id → понятный результат («no such child session»), не crash. Evidence: `T6/task-stop-missing.log`.

**Commit:** `feat(aliases): real SDK delegation for TaskStop/TaskOutput` (только по явной просьбе).

#### T7. C: DCP off везде (deploy-config)

**Goal:** DCP исчезает целиком; `compress` отсутствует в tool schema на всех путях (anthropic и openrouter).

**References:** Owner Decision #1; NixOS repo `/home/astroreen/.local/share/nixos` (`home/astroreen/profiles/terminal/ai/opencode/` — deploy-источники opencode.json/astrocode.jsonc/dcp.jsonc; `opencode/default.nix` — activation copy steps); сервер `/home/astroreen/.config/opencode/opencode.json` (deployed).

**Implementation:**
1. В NixOS-источнике opencode.json (файл ищем в `home/astroreen/profiles/terminal/ai/opencode/`; если opencode.json генерируется `opencode/default.nix` — править генератор): **удалить `@tarquinen/opencode-dcp`** из plugin array. Остальные плагины не трогать.
2. dcp.jsonc (там же): выставить `"compress": {"permission": "deny"}` — страховка, если плагин вернут.
3. Применить деплой: `nixos-rebuild switch` (или принятый на хосте механизм activation) — **проверить**, что `/home/astroreen/.config/opencode/opencode.json` больше не содержит opencode-dcp.
4. В astrocode коде — ничего (DCP не наш). В README/learnings: одна запись «DCP removed per owner decision 2026-10-10; engine D owns context management».
5. Аудит интерференции: убедиться, что без DCP ничего не сломано (slash `/dcp` исчез — ОК; `stripHallucinations` больше не трёт сообщения — ОК, его роль частично займут T10/T16).

**Acceptance:**
- Tool schema (обе сессии: `anthropic/claude-sonnet-5-5` через meridian и `openrouter/xiaomi/mimo-v2.6-pro`) **не содержит** `compress` — дифф-скрипт T8/`spike/probe-tool-schema.ts` (см. T8) прикладывает оба снимка.
- `opencode.json` deployed не содержит `opencode-dcp`; `/dcp` команда недоступна.
- Сессии работают (task/todowrite/fallback живут).

**QA:**
- Happy: `spike/probe-tool-schema.ts` (запуск локально для openrouter + на сервере для anthropic) → `T7/schema-openrouter.json`, `T7/schema-anthropic.json` без `compress`; diff-отчёт `T7/schema-diff.md`.
- Failure: если после правки сервис/сессии падают (DCP всё-таки нужен чему-то) — откат = вернуть запись в plugin array + redeploy; зафиксировать в evidence `T7/rollback-note.md`. (Rollback-ветка обязательна к прогону в QA: временно вернуть плагин → убедиться, что сессии поднимались ДО удаления — baseline-снимок `T7/schema-openrouter-before.json`.)

**Commit (NixOS repo, только по явной просьбе):** `chore(opencode): remove opencode-dcp plugin, deny compress` (отдельный репо `/home/astroreen/.local/share/nixos`; коммит-там отдельно спросить).

#### T8. E: determinism system-слоя + schema hash снимки

**Goal:** `experimental.chat.system.transform` байт-стабилен на сессию; diff между запросами = пусто; попутно — инструмент снимков tool schema (нужен T7/G3).

**References:** `src/index.ts` хук `experimental.chat.system.transform` (append guards, idempotent via `includes`, dump side-channel); `src/prompts/dump.ts`; learnings (output.system pre-filled; subagents горят тоже); `spike/probe-system-transform.js`.

**Implementation:**
1. Freeze-механизм: `Map<sessionID, string[]>` (LRU cap 200, чтобы не растить память) — после первого формирования output.system на sessionID запомнить результат; на последующих вызовах того же sessionID — вернуть замороженное (мутировать output = length=0+push замороженного). Если собранный вариант вдруг отличается от замороженного — `recordSystemDiff` (sha256 обоих) + вернуть замороженный.
2. Аудит динамики: прогнать промпт-сбор на 2 последовательных запросах (`spike/probe-system-transform.ts` — обновить probe) и вычистить источник любых отличий в текущем коде (подозреваемые: timestamp/счётчики — если найдутся; `skill.description.replace(/\s+/g," ")` — детерминирован, не трогать).
3. `spike/probe-tool-schema.ts` — новый probe: достаёт список tools + их parameters через SDK (`/experimental/tool`) и пишет JSON-снимок + sha256 схемы. Используется T7 и G3.
4. Тест `test/system-determinism.test.ts`: 2 вызова transform на одном sessionID → байт-идентичный output; разные sessionID → независимые freeze.

**Acceptance:**
- Два последовательных запроса одной сессии → system prompt байт-идентичен (sha256 равны; evidence diff пуст).
- Subagent-сессия (другой sessionID) не разделяет freeze с родителем.

**QA:**
- Happy: `bun test test/system-determinism.test.ts` → green; headless 2-запросная сессия → `T8/system-diff.json` (два хэша, равны).
- Failure: попытка transform-цикла на сессии с >2 запросами — freeze держится (3-й запрос тот же хэш). Evidence: `T8/system-diff-3turns.json`.

**Commit:** `feat(system): freeze system transform per session + schema probe` (только по явной просьбе).

### Wave 3 — Compaction engine (D; после Wave 2)

Общая доктрина (нарушение = провал): cache epoch (Planner Decisions #4); trigger 70–80% контекста + граница хода/`session.idle`; summary вставляется один раз и замораживается (hash-guard); повторный проход по сжатому региону запрещён; rule-based prune только на epoch break (формат stub фиксированный); LLM-суммаризация только на границе хода, НИКОГДА mid-tool-chain; ровно 1 retry → deterministic fallback; суммаризатор — отдельная дешёвая модель.

#### T9. Trigger + summarizer invocation + config schema

**Goal:** движок запускается по правилам и зовёт суммаризатор отдельной дешёвой моделью.

**References:** T1/T3 (телеметрия), T7 (DCP off —前置), Ground Truth (Спайк 3: `POST /session/{id}/summarize` body `{providerID, modelID}`; Planner Decisions #8 fallback-путь), `src/config/astrocode.ts` (parse-дисциплина), `src/index.ts` event-хуки (`session.idle`, `session.status`, `message.updated`).

**Implementation:**
1. Config block `compaction` в astrocode.jsonc (parse в `src/config/astrocode.ts`):
   ```jsonc
   "compaction": {
     "enabled": true,
     "summarizer_model": "openrouter/xiaomi/mimo-v2.6-pro",  // provider/model — дешёвая
     "trigger_ratio": 0.75,           // допуск 0.7–0.8, валидация
     "context_window": 200000,        // дефолт для ratio; per-model map ниже
     "context_windows": {},           // {"provider/model": 200000}
     "prune_stub_chars": 200,         // допуск 50–2000
     "cooldown_seconds": 300          // анти-спам компакций
   }
   ```
   `max_summary_retries` — константа = 1 (не конфиг; доктрина).
2. `src/compaction/state.ts`: `Map<sessionID, {last_compaction_ts, region_hashes: Set<string>, summary_frozen?: string, in_flight: boolean}>`.
3. `src/compaction/trigger.ts`: оценка контекста = `tokens.input + tokens.cache_read + tokens.cache_write` последнего assistant-сообщения (usage из T1-агрегата) / effective window (`context_windows[model] ?? context_window`). Срабатывание: ratio ≥ `trigger_ratio` И (граница хода — событие `message.updated` завершённого assistant-сообщения, ИЛИ `session.idle`/`session.status` idle) И `cooldown` прошёл И `!in_flight`.
4. `src/compaction/summarize.ts`:
   - PRIMARY: `client.session.summarize(sessionID, {providerID, modelID: summarizer_model})` (route верифицирован). **Probe:** после вызова проверить по usage-телеметрии/событиям, что суммаризация шла НЕ моделью сессии (modelID в событии compaction = summarizer_model). 
   - FALLBACK (probe не подтвердил override ИЛИ route вернул false/4xx): scratch-session путь — `client.session.messages(sessionID)` → собрать transcript-выжимку (последние ≤ 30 сообщений, tool results уже stubbed T10-правилом при сборке prompt'а) → `client.session.create` (parentID = sessionID не обязательно; обычная сессия) → `client.session.prompt` c model `{providerID, modelID}` от summarizer_model → текст ответа = summary. Путь фиксируется в `recordCompaction(path: "native"|"scratch")`.
   - Выбор пути — по probe-результату одной константой `const SUMMARIZER_PATH` в модуле (не runtime-переключалка; правится правкой кода при прояснении).
5. Событие компакции → `recordCompaction` (токены до/после, ratio, path, duration) — поля события фиксированы типом в T3.
6. Тест `test/compaction.test.ts`: ratio-триггер (порог, cooldown, in_flight, disabled); window-map override.

**Acceptance:**
- При ratio ≥ 0.75 на границе хода движок запускается ровно один раз (in_flight+cooldown работают).
- Суммаризатор — дешёвая модель (подтверждено телеметрией); если native-путь override игнорирует — автоматически работает scratch-путь (доказательство в evidence).

**QA:**
- Happy: `bun test test/compaction.test.ts` → green; headless long-run (сгенерировать длинную сессию промптами «прочитай X и ответь») на cheap-модели → в JSONL `compaction` event с `summarizer_model`. Evidence: `T9/compaction-event.jsonl`.
- Failure: summarizer_model указывает на несуществующую модель → 1 попытка scratch-пути тоже падает → deterministic fallback T11 (stub-prune без summary), событие `compaction` c `outcome:"fallback"`, сессия не падает. Evidence: `T9/summarizer-unavailable.log`.

**Commit:** `feat(compaction): rule-triggered engine with separate cheap summarizer` (только по явной просьбе).

#### T10. `messages.transform`: rule-based prune + hash-guard (epoch break)

**Goal:** на epoch break старые tool outputs заменяются фиксированным stub; повторный проход не меняет байты; вне epoch break transform — pass-through.

**References:** Ground Truth (`experimental.chat.messages.transform`; `CompactionPart`), T9 (state), доктрина (Planner Decisions #4).

**Implementation:**
1. `src/compaction/prune.ts`: правило stub'а строго: `text.slice(0, prune_stub_chars) + "\n[pruned by astrocode]"`. Обрезаются **только tool-result parts** сообщений старше последних 2 сообщений и вне текущего tool-chain (последние N=10 parts — не трогать); user-сообщения не трогать никогда; уже stubbed (маркер `[pruned by astrocode]` в хвосте) — не трогать; parts входящие в `region_hashes` — не трогать.
2. Hash-guard: при первом применении stub'а к part — сохранить `sha256(stub-байтов)` в `region_hashes`; любой последующий transform, видящий part с hash из guard и другим содержимым, — **не трогает его** и пишет `recordCompaction(outcome:"guard_conflict")` (не должен происходить; если происходит — баг).
3. **Вне epoch break transform обязан быть pass-through** (ничего не мутировать): guard-флаг `epoch_dirty` в state — prune применяется только в кадре, где T9 инициировал компакцию (единственный transform сразу после триггера) — детерминированный порядок: stub prune → summary injection (T11) → freeze.
4. Summary injection: текст summary вставляется как отдельный synthetic-сообщение (role "user", part text с маркером `<!-- astrocode:summary -->`) перед последними сообщениями; после вставки `summary_frozen` = sha256; повторная компакция того же региона → hash-guard: summary НЕ перегенерируется (если регион не изменился — новый summary не создаётся; `outcome:"skipped"`).
5. Тест `test/compaction.test.ts`: (а) transform вне epoch = идентичный output; (б) prune стабилен (2 применения → байты равны); (в) summary вставляется один раз; (г) guard_conflict не срабатывает на нормальном потоке.

**Acceptance:**
- Повторный компакт того же региона не меняет ни одного байта (hash-guard; equality по sha256 в evidence).
- Вне epoch break история байт-стабильна (включая уже сжатые части).
- 0 циклов «править уже сжатое».

**QA:**
- Happy: `bun test test/compaction.test.ts` → green; в длинной headless-сессии дважды форсировать `/astrocode:compact` (T12) на одном и том же состоянии → второй = `outcome:"skipped"`/no-op, дифф байтов пуст (`T10/recompact-diff.json`).
- Failure: ручная порча summary-блока в history (симуляция) → guard фиксирует `guard_conflict`, движок НЕ перезаписывает в цикле (1 запись, без retry-шторма). Evidence: `T10/guard-conflict.jsonl`.

**Commit:** `feat(compaction): deterministic prune with hash-guarded summary freeze` (только по явной просьбе).

#### T11. Валидация формата summary + bounded retry + deterministic fallback

**Goal:** wrong-format summary → ровно 1 retry → deterministic fallback; ни одной петли.

**References:** T9 (`summarize.ts`), T10 (prune/injection), handoff §8-4 acceptance.

**Implementation:**
1. `src/compaction/format.ts`: `validateSummary(text)`: длина 200–4000 символов; наличие маркеров-заголовков `## Goal`, `## State`, `## Next` (стабильный шаблон; сам шаблон — константа, используется и в prompt T12); без markdown-блоков ошибок/stack traces > 500 символов.
2. Retry-логика в `summarize.ts`: fail #1 → один повтор с prompt'ом + корректирующая приписка (константа: `The previous response violated the required format. Output exactly the three markdown sections ## Goal / ## State / ## Next, 200-4000 chars.`); fail #2 → **deterministic fallback**: summary НЕ вставляется (или вставляется детерминированная заглушка `## Goal\n(compacted without summary)\n## State\nsee pruned tool outputs\n## Next\ncontinue from user request` — выбрать ОДИН вариант, зафиксировать константой; рекомендация — заглушка, чтобы доктрина «summary блок существует» соблюдалась) + `recordCompaction(outcome:"fallback")` + prune от T10 применяется. Более никаких попыток.
3. Тест `test/compaction.test.ts`: невалидный формат → 2 обращения к суммаризатору (mock), затем fallback-заглушка; валидный → 1 обращение; fallback-текст константен.

**Acceptance:**
- Принудительный wrong-format (mock суммаризатора) → ровно 1 retry → deterministic fallback; в логах 0 «wrong format → retry» циклов.
- Число обращений к модели-суммаризатору на компакт ≤ 2.

**QA:**
- Happy: `bun test test/compaction.test.ts` → green; evidence `T11/retry-count.json` (мок-счётчик = 2 на fallback, 1 на успех).
- Failure: суммаризатор молчит/пустой текст оба раза → fallback-заглушка, сессия продолжает работу, `outcome:"fallback"` в JSONL. Evidence: `T11/empty-summary-fallback.jsonl`.

**Commit:** `feat(compaction): bounded summary retry with deterministic fallback` (только по явной просьбе).

#### T12. `experimental.session.compacting` + `/astrocode:compact` + session.compacted telemetry

**Goal:** стабильный prompt компакции; ручной триггер; полная телеметрия compaction-событий.

**References:** Ground Truth (`experimental.session.compacting` out `{context, prompt?}`), `src/index.ts` config hook (инжект команд — паттерн существующих builtin commands), T9–T11.

**Implementation:**
1. Хук `experimental.session.compacting`: `prompt` = константная строка (шаблон валидации T11 — те же `## Goal/## State/## Next` секции; никакой динамики); `context` — пропустить как есть (или ограничить последними сообщениями — мутировать только если probe покажет необходимость; по умолчанию pass-through).
2. `/astrocode:compact` slash-команда (инжект в config hook рядом с существующими builtin-командами): текст-шаблон, который дёргает engine — реализация: команда добавляет в parts сообщение-триггер? Нет — надёжнее: команда регистрируется как `command`, и её template содержит маркер `<!-- astrocode:force-compact -->`; `chat.message`/`messages.transform` ловит маркер и ставит `force_compact` в state → T9 срабатывает немедленно (игнорируя ratio, соблюдая cooldown? — нет: force игнорирует и ratio, и cooldown). Маркер не доходит до модели (transform вырезает и заменяет на нейтральный текст «Compaction requested.»).
3. `session.compacted` event → `recordCompaction(source:"native_event")` — дополнительный сигнал (нативный compact мог сработать и без нас).
4. Тест `test/compaction.test.ts`: force-маркер → триггер при ratio < threshold; prompt-compacting возвращает константу (хэш стабилен).

**Acceptance:**
- `/astrocode:compact` форсит компакцию на короткой сессии; model-visible текст не содержит маркера.
- Prompt компакции байт-идентичен между вызовами (хэш-замер).
- Каждая компакция (ручная и авто) даёт `compaction` event в JSONL с токенами до/после.

**QA:**
- Happy: headless сессия → `/astrocode:compact` (через `opencode run` с command-вызовом или prompt-эквивалентом) → `compaction` event; повторный вызов → `skipped`/`fallback` по guard. Evidence: `T12/manual-compact.jsonl`.
- Failure: вызов `/astrocode:compact` на сессии с включённым `compaction.enabled=false` → понятный отказ (toast «compaction disabled»), ничего не падает. Evidence: `T12/compact-disabled.log`.

**Commit:** `feat(compaction): stable compacting prompt + manual /astrocode:compact` (только по явной просьбе).

### Wave 4 — Policies & hygiene (G, H, F; после Wave 1; G/H могут идти параллельно с Wave 3; F — после T8)

#### T13. G: thinking policy по ролям (per-model overrides)

**Goal:** дешёвые разведывательные агенты не платят output-цену thinking'а; конфиг декларативно управляет.

**References:** `src/models/tuning.ts` (REASONING_LEVELS, `reasoningConfigForFamily`), `src/index.ts` chat.params; `src/config/astrocode.ts`; astrocode.jsonc (12 агентов, модели известны).

**Implementation:**
1. Config: `reasoning_overrides` map в astrocode.jsonc:
   ```jsonc
   "reasoning_overrides": {
     "openrouter/xiaomi/mimo-v2.6-pro": {"level": "minimal", "clear_thinking": false},
     "z-ai/glm-5.3-flash": {"level": "off"},
     "anthropic/claude-sonnet-5-5": {"level": "high", "clear_thinking": true}
   }
   ```
   Ключ = `providerID/modelID` (полный id, тот же формат, что в fallback-цепях). `level` ∈ REASONING_LEVELS. `clear_thinking` — булев, **всегда явный** для claude-family (дефолты генерационно-зависимы). Опционально `budget_tokens: number` (claude).
2. `chat.params`: override (по `input.model.id`) ?? family-дефолт. Клаcсификация агентов: в astrocode.jsonc проставить `minimal/off` для разведки (`explore`, `librarian` и др. дешёвые), `medium/high` для ревью/корневых причин — конкретные значения в конфиге фиксируются при реализации по списку агентов (12 шт., см. deploy-источник).
3. `clear_thinking` пробрасывается в `options` (provider options) для claude-family явно; для остальных — не трогать.
4. Тест `test/reasoning-overrides.test.ts`: map-парсинг; precedence override>family; `splitReasoningSuffix` не конфликтует (level-suffix в model id бьёт override — правило: suffix в id сильнее override; зафиксировать в типах и README).

**Acceptance:**
- astrocode.jsonc декларативно меняет thinking per-model; замер T1 показывает падение `tokens.output` (и `tokens.reasoning`) на explore-сессиях ≥ 30% к baseline; tool-error rate не вырос (сравнение JSONL-окон).

**QA:**
- Happy: `bun test test/reasoning-overrides.test.ts` → green; две headless-сессии (baseline без override / с `minimal`) одинаковым промптом на mimo → `T13/output-tokens-compare.json` (output упал).
- Failure: override для неизвестной модели → молча family-дефолт + 1 запись `log.warn` (не падение). Evidence: `T13/unknown-model-override.log`.

**Commit:** `feat(reasoning): per-model thinking overrides via astrocode.jsonc` (только по явной просьбе).

#### T14. H: fallback observability (события + per-model cooldown)

**Goal:** полная видимость цепочек fallback; per-model cooldown; не сломать settleChild/evaluateChild патч.

**References:** `src/fallback/{index,config,state,session-model,subagent}.ts`; T3 (`recordFallback`); NixOS `opencode-task-fallback.patch` (НЕ трогать).

**Implementation:**
1. В точках dispatch fallback (`src/fallback/index.ts`, `src/index.ts` message.updated/session.status) — `recordFallback`: `{chain_index, from_model, to_model, error_name, error_class: "terminal"|"transient", cooldown_until, reason}` (поля фиксированы типом в T3).
2. Config расширение: `fallback.cooldown_seconds_by_model: {"provider/model": number}` (парсинг `asNonNegativeInt`-паттерном; дефолт = глобальный `cooldown_seconds`). Применять при выборе звена цепи.
3. Аудит: прогнать `bun test` целиком — subagent-ветки (`subagent.ts`) не изменились по поведению (patch-контракт). Диффом подтвердить, что `subagent.ts` и сигнатуры settleChild-взаимодействия не тронуты (если правки не нужны — вообще не открывать файл).
4. Тест `test/fallback-events.test.ts`: recordFallback payload; cooldown per-model override (мок часов).

**Acceptance:**
- Каждый fallback → запись с полной цепочкой (from/to/reason/cooldown) в JSONL.
- Per-model cooldown работает (второй отказ в окне cooldown → звено не выбирается).
- `bun test` зелёный; subagent-fallback поведение не изменилось.

**QA:**
- Happy: `bun test test/fallback-events.test.ts` → green; headless сессия с заведомо невалидным ключом первой модели → цепочка fallback в JSONL (`T14/fallback-chain.jsonl`).
- Failure: error вне `retry_on_errors` → 0 fallback-записей (не шумим), терминальный error виден в `tool_error`/usage (error field). Evidence: `T14/terminal-no-fallback.log`.

**Commit:** `feat(fallback): telemetry events + per-model cooldown` (только по явной просьбе).

#### T15. F: schema hygiene validator (`tool.definition`)

**Goal:** схемы тулов не ломают Anthropic-протокол; находки логируются; наши тулы чистые.

**References:** Ground Truth (`tool.definition` out `{description, parameters}`; MCP root-level anyOf/oneOf/allOf ломают протокол; имя `^[a-zA-Z0-9_-]{1,64}$`), T8 (`spike/probe-tool-schema.ts`), T3 (`recordSchemaViolation` — helper добавить в T3? — нет: T15 добавляет helper в `src/telemetry/log.ts`, extend T3-модуль).

**Implementation:**
1. `src/validation/schema.ts`: `validateToolSchema(name, parameters)` → `Violation[]`: (а) имя по regex; (б) root `type !== "object"` ИЛИ root-level `anyOf|oneOf|allOf` (включая вложенный `$ref`-loop проверку — минимально: отсутствие `type` + наличие `anyOf` на root); (в) `required` ⊄ `properties` keys; (г) пустые descriptions у под-полей — warning-уровень.
2. Хук `tool.definition`: прогнать валидацию; нарушения → `recordSchemaViolation` + `log.warn`; **режим `log_only: true` по умолчанию** (config `schema_validator: {enabled: boolean, log_only: boolean}`). В `log_only:false` — безопасные репейры только для root-level отсутствия `type` (добавить `"type":"object"` если есть `properties`) — НЕ переписывать anyOf-семантику (это ломает смысл); для anyOf-root — только лог + рекомендация.
3. Отчёт: прогнать `spike/probe-tool-schema.ts` на обоих путях → список нарушений; для MCP-инструментов с root-anyOf — митигейшн в отчёте: per-agent `tools: {mcp_tool_name: false}` в astrocode.jsonc (исключить на anthropic-путях), правка upstream-схем — вне scope.
4. Тест `test/schema-validator.test.ts`: детект anyOf-root; regex-имени; required-несогласованность; log_only vs repair.

**Acceptance:**
- Валидатор активен; на текущем наборе тулов astrocode (не MCP) — 0 нарушений; любые MCP-нарушения перечислены в `T15/report.md` с именами.
- `tool.definition` не ломает валидные схемы (ничего не мутирует в log_only).

**QA:**
- Happy: `bun test test/schema-validator.test.ts` → green; `spike/probe-tool-schema.ts` → `T15/schema-report.json` (0 violations на наших).
- Failure: передать в валидатор схему с root `oneOf` → violation зафиксирован, схема не «починена» криво (log_only), LLM-запрос с такой схемой уходит с предупреждением в лог. Evidence: `T15/oneof-root-violation.json`.

**Commit:** `feat(validation): tool schema hygiene validator on tool.definition` (только по явной просьбе).

### Wave 5 — Cleanup (I; строго после T5)

#### T16. I: вычистить remap-текст из model-visible prompt'ов

**Goal:** модель больше не видит remap-таблиц «X → Y» (источник «исправлений» имён в code blocks); портинг-археология сохранена в JS-комментариях (не в токенах).

**References:** `src/commands/index.ts` (HTML-comment compat-таблицы в template-строках ~347–349 и ~632–634; header 4–8, 13; строки ~735–760 — team-mode addendum, не применяемый); `src/prompts/sisyphus/sections.ts` (remap-упоминания, `todowrite`-variant wording) и `src/prompts/sisyphus/families/*.ts` (bg_.../background_output заметки в header-комментариях — уже JS-комментарии, оставить); `docs/plugin-test-prompt.md` (регрессионный сценарий).

**Implementation:**
1. Перенести содержимое HTML-comment compat-таблиц из template-строк команд в **JS block-комментарии** рядом с функцией (портинг-заметки «не удалять» соблюдаются — они остаются в source, но не в prompt-токенах).
2. Вычистить из model-visible текста templates/секций любые инструкции-переводы имён (`TodoWrite`→`todowrite` и т.п.): оставить единственное место с каноничными именами (краткая строка «Your toolset: task, todowrite, todoread, …» — без таблиц соответствий). Алиасы (T5) покрывают вызовы.
3. Grep-гейт (команда верификации): `grep -nE 'call_omo_agent|TodoWrite|TaskCreate|TaskUpdate|team_create|background_output|multi_agent_v1' src/commands/index.ts src/prompts/ -r` → в model-visible строках (вне комментариев) **0 совпадений**; сохранить вывод в `T16/grep-gate.txt`.
4. Регрессия по `docs/plugin-test-prompt.md`: task delegation + todowrite + LSP-сценарии без remapping-текста.

**Acceptance:**
- Grep-гейт чист; prompt-сборка (dump) не содержит таблиц соответствий имён (diff с baseline — `T16/prompt-diff.md`).
- Регрессионный прогон сценариев зелёный; модель корректно вызывает task/todowrite (alias-перехват не требуется в норме).

**QA:**
- Happy: grep-гейт + `bun test` + headless прогон `docs/plugin-test-prompt.md` сценария (сокращённый) → `T16/regression.md`.
- Failure: если модель в регрессии начинает звать галлюцинированные имена чаще (remap-текст был её подсказкой) — вернуть ОДНУ нейтральную строку-подсказку с каноничными именами (без таблиц), повторить регрессию; зафиксировать в evidence `T16/hint-restored.md`.

**Commit:** `refactor(prompts): drop tool-name remap tables from model-visible text` (только по явной просьбе).

#### T17. Final gate — полный прогон + soak-чеклист + билинг-сверка

**Goal:** доказать acceptance всех workstreams на живых прогонах; закрыть план.

**References:** все T; Verification Gates ниже; `/home/astroreen/reports/Frontier против дешёвых моделей.md` (контекст tier-экономики — только для чтения отчёта).

**Implementation:**
1. Прогнать всё: `bun run typecheck && bun test` → green; все evidence-папки T1–T16 на месте.
2. **Soak cheap-run (2 дня):** фоновая headless-сессия на `openrouter/xiaomi/mimo-v2.6-pro` с рабочим сценарием (30+ запросов, форс длинного контекста) → итоговый отчёт по JSONL: cache_ratio средний ≥ 0.95, compactions count/impact, 0 retry-циклов.
3. **Soak Claude+meridian-run (1–2 дня, на сервере):** реальная рабочая сессия через meridian (human uses it) → те же метрики + alias-статистика.
4. **Билинг-сверка:** сумма `cost_usd` из JSONL против OpenRouter dashboard за окно прогона — допуск ±10%; расхождение → разобрать поля usage (задокументировать в отчёте).
5. Итоговый отчёт `T17/final-report.md`: по каждому Verification Gate — pass/fail + evidence-ссылки; рекомендация по `MERIDIAN_BETA_POLICY=allow-all` (upstream/config, не реализовывать).
6. Append выводов в `.sisyphus/notepads/astrocode-plugin/learnings.md` (новые готчи: исход B0, summarize-path, sanitizer и пр.).

**Acceptance:** все 6 Verification Gates — pass; отчёт + notepad обновлены.

**QA:**
- Happy: скрипт сводки `bun -e` по JSONL → `T17/soak-summary.json`; `T17/final-report.md` содержит все gate-статусы.
- Failure: любой gate = fail → отчёт честно фиксирует fail + какие T требуют фикса (не закрывать план вслепую). Evidence: сам отчёт.

**Commit:** `docs: final verification report for telemetry/cache/tool-reliability plan` (только по явной просьбе; обычно не нужен — отчёт в evidence).

### Final Verification Wave (MANDATORY — после всех T)

1. `bun run typecheck && bun test` — полный green (последний запуск, evidence `final/typecheck-test.log`).
2. Прогнать все 6 Verification Gates ниже целиком, приложить evidence-ссылки.
3. Проверить Must-NOT-Have: `grep -rn "as any\|@ts-ignore\|@ts-expect-error" src/ test/` → 0; пустых catch (`catch {}` / `catch (e) {}` без тела) → 0; `git status` — только ожидаемые файлы; никаких правок в `node_modules`/`.cache`.
4. Проверить, что vibeguard нигде не упомянут в диффе.
5. Готовность коммитов: сообщения из T-блоков; git commit — только после явного запроса пользователя.

## Dependency Matrix

| Item | Depends on | Blocks | Wave |
|---|---|---|---|
| T1 telemetry sink | — | T2, T3, T9, T13, T14 | 1 |
| T2 budget | T1 | — | 1 |
| T3 event sinks | T1 | T5, T9, T14, T15 | 1 |
| T4 B0 spike | — | T5 (acceptance wording) | 2 |
| T5 aliases | T3, T4 | T6, T16 | 2 |
| T6 delegate side-effects | T5 | — | 2 |
| T7 DCP off | — | T9 | 2 |
| T8 system freeze + schema probe | — | T15, G3 | 2 |
| T9 trigger+summarizer | T1, T3, T7 | T10, T11, T12 | 3 |
| T10 prune+hash-guard | T9 | T12 | 3 |
| T11 retry+fallback | T9 | T12 | 3 |
| T12 compacting prompt+command | T9, T10, T11 | T17 | 3 |
| T13 thinking overrides | T1 | — | 4 |
| T14 fallback obs | T1, T3 | — | 4 |
| T15 schema validator | T3, T8 | — | 4 |
| T16 remap cleanup | T5 | T17 | 5 |
| T17 final gate | all | — | 5 |

Параллельные допуски: Wave 1 (T2∥T3 после T1); Wave 2 (T4∥T7∥T8; T5 после T3/T4; T6 после T5); Wave 3 строго последователен T9→(T10∥T11)→T12; Wave 4 (T13∥T14, T15 после T8); Wave 5 последователен.

## Verification Gates (после волн и на финише; каждый gate — с evidence-путём)

| Gate | Условие pass | Как измерять | Evidence |
|---|---|---|---|
| **G1 Cache** | cache_ratio ≥ 0.95 (avg) на 2-дневном cheap-run И на Claude+meridian-run; сверка билинга ±10% | JSONL T1 агрегация; OpenRouter dashboard | `T17/soak-summary.json`, `T17/billing-check.md` |
| **G2 Aliases** | Claude+meridian: промпт «вызови Task_Create» → canonical tool выполнен ровно 1 раз следующим ходом, 0 error-parts; 0 «unknown tool» в логах; (при Outcome B — 0 native-SDK выполнений + guard) | живая сессия + JSONL alias_hit | `T5/meridian-alias.md`, `T5/alias-redirect.jsonl` |
| **G3 DCP off** | `compress` отсутствует в tool schema на anthropic И openrouter путях; DCP не в plugin array | `spike/probe-tool-schema.ts` снимки | `T7/schema-diff.md`, `T7/schema-*.json` |
| **G4 Compaction** | wrong-format summary → ровно 1 retry → deterministic fallback; повторный компакт региона = 0 байтов diff (hash-guard); 0 retry-циклов в логах | мок-тесты + живой force-compact | `T11/retry-count.json`, `T10/recompact-diff.json` |
| **G5 Determinism** | system prompt двух последовательных запросов одной сессии — байт-идентичен (sha256 равны, diff пуст) | probe T8 | `T8/system-diff.json` |
| **G6 Budget** | лимит → tool call заблокирован (throw), toast-уведомление пришло, budget_block в JSONL | headless-сессия с `session_usd: 0.001` | `T2/budget-block.log`, `T2/budget-block.jsonl` |

## Rollback

**Принцип:** каждая подсистема за feature flag в astrocode.jsonc (Planner Decisions #10) — отключение = конфиг + redeploy (NixOS activation копирует), без code revert. Code revert — по git, сообщения коммитов из T-блоков.

| Подсистема | Флаг конфига | Откат |
|---|---|---|
| Телеметрия | `telemetry.enabled=false` | I/O прекращается; ничего не ломается |
| Бюджет | `budget.enabled=false` | throw-путь выключен |
| Алиасы | `aliases.enabled=false` | тулы не регистрируются |
| Compaction | `compaction.enabled=false` | триггеры молчат; ручная команда отвечает «disabled» |
| Thinking overrides | `reasoning_overrides={}` | family-дефолты |
| Schema validator | `schema_validator.enabled=false` | хук pass-through |
| DCP (T7) | — (plugin удалён) | вернуть запись `@tarquinen/opencode-dcp` в plugin array NixOS-opencode.json + redeploy; `dcp.jsonc` `compress.permission` уже deny — вернуть `default` |
| Промпт-cleanup (T16) | — | git revert T16 коммита |

**Волна-уровень:** каждый T коммитится отдельно (сообщение готово) — revert по git отдельного коммита безопасен; T9–T12 (engine) откатываются одним revert-ом цепочки при провале G4. Провал G1/G2/G4/G5/G6 на Final Wave — план НЕ закрывать; вернуться к виновному T по Dependency Matrix.

**Данные:** телеметрийные JSONL — append-only, удаление не требуется; compaction state — in-memory (перезагрузка плагина = новый epoch, summary пересоздастся один раз — документированное поведение, не баг).

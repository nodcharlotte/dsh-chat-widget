/**
 * @local/chat-widget —— 存储层。
 *
 * 存五样东西：
 *   - `messages`        对话原文（界面上的删除键删的就是它）
 *   - `memories`        从对话里挑出来的原句（一条 = 一问一答，或它自己的一句）
 *   - `screen_memories` 陪看的屏幕记忆（`text` = 模型看到的、`subtitle` = OCR 抄下来的字幕原文）
 *   - `window_events`   前台窗口变化全量记录（陪看跑着时才有）
 *   - `meta`            库自己的小状态（`store_id`）
 *
 * facts / episodes / FTS、成长版本这些表不再创建。
 * 老库里如果还留着它们，本文件不读、不写、也不删（要清就手工清，或者删掉整个数据目录）。
 *
 * 两条硬性约束决定了这里的实现：
 *   1) 数据目录可自定义，**库文件扁平放在目录里**；截图文件另放在 `shots/` 子目录
 *      （这条"不建子目录"只管库表，不管截图）
 *   2) 目录/文件被删**不得报错**：库被删 = 空库 = 会话完全重置
 *
 * 为了满足第 2 条，这里**不长期持有数据库句柄**——每次操作开一次、用完立刻关。
 * Windows 上删不掉被进程占用的文件：常驻连接会让"用户自己删掉数据文件夹"变成共享冲突。
 *
 * @module @local/chat-widget/store
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dshHomePath } from './host/home.js';

/** 默认数据目录。 */
export const DEFAULT_STORE_DIR = 'X:/AI_History';

/** 数据库文件名。 */
const DB_FILE = 'chat.db';

/** 单次查询默认返回的消息条数。 */
export const DEFAULT_PAGE_SIZE = 30;

/** 单页上限，避免异常请求把整库拖出来。 */
const MAX_PAGE_SIZE = 200;

/** 归一一个目录字符串：去空白、去尾部斜杠。 */
function normalizeDir(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  return trimmed === '' ? fallback : trimmed;
}

/** 确保目录存在。 */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return '';
  } catch (error) {
    return error !== null && typeof error === 'object' && error.message ? String(error.message) : String(error);
  }
}

/**
 * 解析实际使用的数据目录：建不出来就回落到 DSH home 下的备用目录，并把原因带回。
 * @param {unknown} configured - 配置里的目录。
 * @returns {{dir: string|null, used: string, fallback: boolean, reason: string}} 解析结果。
 */
export function resolveStoreDir(configured) {
  const wanted = normalizeDir(configured, DEFAULT_STORE_DIR);
  const wantedProblem = ensureDir(wanted);
  if (wantedProblem === '') return { dir: wanted, used: wanted, fallback: false, reason: '' };

  const fallbackDir = dshHomePath('chat-widget', 'data');
  const fallbackProblem = ensureDir(fallbackDir);
  if (fallbackProblem === '') {
    return { dir: fallbackDir, used: fallbackDir, fallback: true, reason: `${wanted} 不可用（${wantedProblem}）` };
  }
  return {
    dir: null,
    used: wanted,
    fallback: true,
    reason: `${wanted} 不可用（${wantedProblem}）；回落目录也不可用（${fallbackProblem}）`,
  };
}

/**
 * 补一列（列已存在就什么都不做）。
 * 老库是"消息版"建的，没有 `indexed_at` / `ingest_due_at`，必须能原地升级。
 * @param {DatabaseSync} db - 已打开的数据库。
 * @param {string} table - 表名。
 * @param {string} column - 列名。
 * @param {string} decl - 列定义。
 */
function addColumn(db, table, column, decl) {
  const columns = db.prepare(`pragma table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${decl}`);
}

/**
 * 建表（幂等）。契约：`meta` + `messages` + `memories`。
 * @param {DatabaseSync} db - 已打开的数据库。
 */
function migrate(db) {
  db.exec(`
    create table if not exists meta (
      key text primary key,
      value text not null
    );

    create table if not exists messages (
      id integer primary key autoincrement,
      role text not null,
      content text not null,
      created_at integer not null,
      error text
    );
    create index if not exists idx_messages_created_at on messages(created_at);

    -- 一条记忆 = 一问一答（或它单独一句）里**挑出来的原句**。
    -- from_msg 为 null 表示这轮是"它自己开口"，没有配对的我那句话。
    create table if not exists memories (
      id       integer primary key autoincrement,
      at       integer not null,
      from_msg integer,
      to_msg   integer not null,
      text     text    not null,
      vec      blob    not null,
      dim      integer not null
    );
    create index if not exists idx_memories_at on memories(at);
  `);

  // 入库倒计时：助手消息落库时写 due，到点了才轮到抽取。
  // `indexed_at` 非空表示这条消息已经被处理过（不管最后有没有建成记忆）。
  addColumn(db, 'messages', 'indexed_at', 'integer');
  addColumn(db, 'messages', 'ingest_due_at', 'integer');
  // 自主开口（它自己找话说）：它不是对话的一轮，配对时不能算进去
  addColumn(db, 'messages', 'autonomous', 'integer');
  // 这句话是在哪个模式下说的（focus / play / null=普通聊天）——
  // 用来避免"上一个模式的语气"污染当前模式的上下文。
  addColumn(db, 'messages', 'mode', 'text');
  db.exec('create index if not exists idx_messages_due on messages(ingest_due_at) where indexed_at is null');

  // 屏幕陪看：屏幕记忆（独立于聊天记忆库，物理分开，互不污染）
  db.exec(`
    create table if not exists screen_memories (
      id         integer primary key autoincrement,
      at         integer not null,
      app        text,
      title      text,
      kind       text    not null default 'raw',
      text       text    not null,
      frame      text,
      vec        blob    not null,
      dim        integer not null,
      scale      real    not null,
      compressed integer not null default 0,
      day        text    not null,
      created_at integer not null,
      subtitle   text
    );
    create index if not exists idx_sm_at      on screen_memories(at);
    create index if not exists idx_sm_day_app on screen_memories(day, app);
    create index if not exists idx_sm_kind    on screen_memories(kind, compressed);

    create table if not exists window_events (
      id      integer primary key autoincrement,
      at      integer not null,
      hwnd    integer,
      process text,
      title   text
    );
    create index if not exists idx_we_at      on window_events(at);
    create index if not exists idx_we_process on window_events(process, at);
  `);

  // 字幕层（v3）：这一行的画面字幕**原文**（几行用 ' / ' 连接；没锁上字幕就是 NULL）。
  // 老库原地补列；不建索引（每批最多几行短文本，跟着 text 一起读）。
  addColumn(db, 'screen_memories', 'subtitle', 'text');
}

/** 读取（必要时创建）本库的 store_id。 */
function readOrCreateStoreId(db) {
  const row = db.prepare('select value from meta where key = ?').get('store_id');
  if (row !== null && row !== undefined && typeof row.value === 'string' && row.value !== '') return row.value;
  const id = randomUUID();
  db.prepare('insert or replace into meta(key, value) values (?, ?)').run('store_id', id);
  return id;
}

/**
 * 打开库、建表、执行一段操作、然后立刻关闭。
 * 任何一步失败都只返回 `{ok:false}`，绝不抛给上层。
 *
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {(db: DatabaseSync, info: object) => any} fn - 操作。
 * @returns {{ok: true, value: any, dir: string, storeId: string, fallback: boolean, reason: string}
 *   | {ok: false, error: string, dir: string|null, fallback: boolean, reason: string}} 结果。
 */
export function withStore(configuredDir, fn) {
  const resolved = resolveStoreDir(configuredDir);
  if (resolved.dir === null) {
    return { ok: false, error: 'storage-unavailable', dir: null, fallback: true, reason: resolved.reason };
  }

  let db = null;
  try {
    db = new DatabaseSync(join(resolved.dir, DB_FILE));
    db.exec('pragma busy_timeout = 3000');
    // WAL：读不挡写、写不挡读。写进库文件头后是持久的；库正忙时只会返回旧模式，不该让本次失败。
    try {
      db.exec('pragma journal_mode = wal');
    } catch {
      /* 库正忙：下次打开再试 */
    }
    migrate(db);
    const storeId = readOrCreateStoreId(db);
    const info = { dir: resolved.dir, storeId, fallback: resolved.fallback, reason: resolved.reason };
    return { ok: true, value: fn(db, info), dir: info.dir, storeId: info.storeId, fallback: info.fallback, reason: info.reason };
  } catch (error) {
    return {
      ok: false,
      error: error !== null && typeof error === 'object' && error.message ? String(error.message) : String(error),
      dir: resolved.dir,
      fallback: resolved.fallback,
      reason: resolved.reason,
    };
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        /* 已经关掉了就算了 */
      }
    }
  }
}

/**
 * 追加一条消息。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{role: string, content: string, error?: string|null, ingestDueAt?: number|null, autonomous?: boolean}} message - 消息。
 *   `ingestDueAt` 只有助手消息需要传：那是"到这一刻才轮到入库"的绝对时刻。
 *   `autonomous` 标记"它自己开口"（不是回答谁）。
 * @returns {ReturnType<typeof withStore>} 结果，成功时 value 为新消息 id。
 */
export function appendMessage(configuredDir, message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content = typeof message.content === 'string' ? message.content : '';
  const errorText = typeof message.error === 'string' && message.error !== '' ? message.error : null;
  const dueAt = Number.isFinite(message.ingestDueAt) ? Math.round(message.ingestDueAt) : null;
  const autonomous = message.autonomous === true ? 1 : 0;
  const mode = message.mode === 'focus' || message.mode === 'play' ? message.mode : null;
  return withStore(configuredDir, (db) => {
    const result = db
      .prepare('insert into messages(role, content, created_at, error, ingest_due_at, autonomous, mode) values (?, ?, ?, ?, ?, ?, ?)')
      .run(role, content, Date.now(), errorText, dueAt, autonomous, mode);
    return Number(result.lastInsertRowid);
  });
}

/** 一行消息 → 界面用的对象。 */
function mapMessageRow(row) {
  return {
    id: Number(row.id),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: Number(row.created_at),
    error: typeof row.error === 'string' && row.error !== '' ? row.error : null,
    // 非空 = 这条消息已经参与过一条记忆（界面上的「已记住」）
    indexedAt: row.indexed_at === null || row.indexed_at === undefined ? null : Number(row.indexed_at),
    // true = 它自己开口（不是回答谁）
    autonomous: Number(row.autonomous) === 1,
    mode: typeof row.mode === 'string' && row.mode !== '' ? row.mode : null,
  };
}

/** 读消息时统一取的列。 */
const MESSAGE_COLUMNS = 'id, role, content, created_at, error, indexed_at, autonomous, mode';

/**
 * 读取一页消息（按时间升序返回，便于直接渲染）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{before?: number|null, limit?: number}} [options] - 分页参数。
 * @returns {ReturnType<typeof withStore>} 结果，成功时 value 为消息数组。
 */
export function listMessages(configuredDir, options = {}) {
  const before = Number.isInteger(options.before) ? options.before : null;
  const rawLimit = Number.isInteger(options.limit) ? options.limit : DEFAULT_PAGE_SIZE;
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, rawLimit));
  return withStore(configuredDir, (db) => {
    const rows = before === null
      ? db.prepare(`select ${MESSAGE_COLUMNS} from messages order by id desc limit ?`).all(limit)
      : db.prepare(`select ${MESSAGE_COLUMNS} from messages where id < ? order by id desc limit ?`).all(before, limit);
    return rows.reverse().map(mapMessageRow);
  });
}

/**
 * 取「最近 N 条」上下文。
 *
 * **1 条 = 它说的一句**（一问一答 = 它那句 + 我那句；它自己开口 = 1 条）。
 * 所以这里按**助手消息**数往回数：找到第 N 条助手消息，再从它前面那条我发的话开始，
 * 一直取到最新。这样窗口边界永远落在"一轮的开头"，不会出现半截问答。
 *
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number} utterances - 要几条（1–50）。
 * @returns {ReturnType<typeof withStore>} 结果，成功时 value 为 `{messages, startId}`。
 */
export function recentContext(configuredDir, utterances) {
  const k = Math.min(50, Math.max(1, Number.isInteger(utterances) ? utterances : 7));
  return withStore(configuredDir, (db) => {
    const anchor = db
      .prepare("select id from messages where role = 'assistant' order by id desc limit 1 offset ?")
      .get(k - 1);
    let rows;
    if (anchor === undefined || anchor === null) {
      // 助手消息不够 k 条：从最新往回取，最多 k 轮（够用且不会把整库拖出来）
      rows = db.prepare(`select ${MESSAGE_COLUMNS} from messages order by id desc limit ?`).all(k * 2).reverse();
    } else {
      const anchorId = Number(anchor.id);
      const prev = db.prepare('select id, role from messages where id < ? order by id desc limit 1').get(anchorId);
      const startId = prev !== undefined && prev !== null && prev.role === 'user' ? Number(prev.id) : anchorId;
      rows = db.prepare(`select ${MESSAGE_COLUMNS} from messages where id >= ? order by id asc`).all(startId);
    }
    const messages = rows.map(mapMessageRow);
    return { messages, startId: messages.length === 0 ? null : messages[0].id };
  });
}

/**
 * 硬删一条消息。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number} id - 消息 id。
 * @returns {ReturnType<typeof withStore>} 结果，成功时 value 为被删条数。
 */
export function deleteMessage(configuredDir, id) {
  return withStore(configuredDir, (db) => Number(db.prepare('delete from messages where id = ?').run(id).changes));
}

/**
 * 存储状态（给 /health 用）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @returns {object} 状态。
 */
export function storeStatus(configuredDir) {
  const result = withStore(configuredDir, (db) => ({
    storeId: readOrCreateStoreId(db),
    messages: Number(db.prepare('select count(*) as c from messages').get().c),
  }));
  if (result.ok !== true) {
    return { dir: result.dir, storeId: '', fallback: result.fallback, reason: result.reason, messages: 0, error: result.error };
  }
  return {
    dir: result.dir,
    storeId: result.value.storeId,
    fallback: result.fallback,
    reason: result.reason,
    messages: result.value.messages,
  };
}

/**
 * 读一个 `meta` 值（读不到就返回空串）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {string} key - 键。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为字符串。
 */
export function readMeta(configuredDir, key) {
  return withStore(configuredDir, (db) => {
    const row = db.prepare('select value from meta where key = ?').get(String(key));
    return row === undefined || row === null || typeof row.value !== 'string' ? '' : row.value;
  });
}

/**
 * 写一个 `meta` 值。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {string} key - 键。
 * @param {string} value - 值。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为 true。
 */
export function writeMeta(configuredDir, key, value) {
  return withStore(configuredDir, (db) => {
    db.prepare('insert or replace into meta(key, value) values (?, ?)').run(String(key), String(value));
    return true;
  });
}

/**
 * 清空历史数据：**消息 + 记忆 + 屏幕记忆（含字幕原文）+ 窗口记录**。
 *
 * 人格（SOUL.md）与成长日记（GROWTH.md）是**设定**不是历史，它们在文件里，这里一个都不碰；
 * 截图文件（`shots/`）也不在这清（那是文件不是库，要删就手删目录）。
 * 字幕原文就存在 `screen_memories.subtitle` 里，所以清屏幕记忆时它一起没了。
 *
 * 表里的 id 是 autoincrement，删空后新 id 不会回退（sqlite_sequence 记着旧的最大值），
 * 所以「已记住」这类以 id 为准的东西不会因为清空而串位。
 *
 * @param {unknown} configuredDir - 配置的数据目录。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为
 *   `{messages, memories, screenMemories, windowEvents}` 条数。
 */
export function clearHistory(configuredDir) {
  return withStore(configuredDir, (db) => ({
    messages: Number(db.prepare('delete from messages').run().changes),
    memories: Number(db.prepare('delete from memories').run().changes),
    // 屏幕记忆（`subtitle` 列 = 字幕原文，跟着一起删）
    screenMemories: Number(db.prepare('delete from screen_memories').run().changes),
    windowEvents: Number(db.prepare('delete from window_events').run().changes),
  }));
}

// ── 记忆 ────────────────────────────────────────────────────────────────

/** 单次扫描最多处理几轮：积压很多时分批吃完，不要一次把模型占死。 */
const MAX_DUE_BATCH = 4;

/** 检索时一次最多读多少条记忆向量。 */
const MAX_MEMORY_SCAN = 5000;

/** 向量 → BLOB。 */
function toVectorBlob(vec) {
  const floats = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength).slice();
}

/** BLOB → 向量（拷一份，保证 4 字节对齐）。 */
function fromVectorBlob(blob) {
  if (blob === null || blob === undefined) return new Float32Array(0);
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

/**
 * 找出现在「到点了、还没入库」的助手消息，连同它前面那条**我发的话**（如果该配对）。
 *
 * 配对规则（只有两种）：
 *   A 前面紧挨着的**连续几条**我方消息、且都还没入库 → 一问（或连问几句）一答，一起入。
 *     为什么要"连续几条"：实测有一种行序「我问『他们在干啥呢？』→ 立刻中止（它没回）→
 *     我再问『剧情还行』→ 它回」。按"只配紧挨着的那一条"的旧规则，第一句会**永远没进库**
 *     （它后面再没有新的回复去配它，界面上永远是 ✕）。
 *   B 否则 → 只入它这一句
 *
 * **自主开口（`autonomous`）永远是 B**；找"前面那串"时也**跳过它们**——
 * 否则它插在你和它的回复中间时，会把"它自己找的话"配成对你那句的回答，
 * 而真正的回复反而变成单独一条（实测那种行序：我的话 → 它自主开口 → 它的回复）。
 *
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number} now - 当前时刻。
 * @param {number} [limit] - 本次最多取几轮。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为
 *   `{assistantId, assistantText, user: {msgId, text}|null, users: {msgId, text}[]}[]`；
 *   `user` 是**最近那条**（老调用方兼容），`users` 按时间**从早到晚**，空数组 = 不配。
 */
export function dueIngestPairs(configuredDir, now, limit = MAX_DUE_BATCH) {
  const batch = Math.min(20, Math.max(1, Number.isInteger(limit) ? limit : MAX_DUE_BATCH));
  return withStore(configuredDir, (db) => {
    const rows = db
      .prepare(`select id, content, autonomous from messages
                 where role = 'assistant' and indexed_at is null
                   and ingest_due_at is not null and ingest_due_at <= ?
                 order by ingest_due_at asc, id asc limit ?`)
      .all(now, batch);
    // 往前扫"连续的我方消息"：跳过自主开口；碰到它自己的回复、或一条已经入过库的我方消息就停。
    const scanStmt = db.prepare(`select id, role, content, indexed_at, autonomous from messages
                                  where id < ? order by id desc limit 40`);
    return rows.map((row) => {
      const id = Number(row.id);
      const isAutonomous = Number(row.autonomous) === 1;
      const users = [];
      if (isAutonomous === false) {
        for (const prev of scanStmt.all(id)) {
          if (Number(prev.autonomous) === 1) continue; // 自主开口不算一轮：跳过，继续往前
          if (prev.role !== 'user') break; // 它自己上一条回复：这一串提问到此为止
          if (prev.indexed_at !== null && prev.indexed_at !== undefined) break; // 已经进过库的别再配一次
          users.push({ msgId: Number(prev.id), text: typeof prev.content === 'string' ? prev.content : '' });
        }
        users.reverse(); // 从早到晚
      }
      return {
        assistantId: id,
        assistantText: typeof row.content === 'string' ? row.content : '',
        user: users.length === 0 ? null : users[users.length - 1],
        users,
      };
    });
  });
}

/**
 * 标记消息「已处理」。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number[]} ids - 消息 id。
 * @param {number} at - 处理时刻。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为被标记条数。
 */
export function markMessagesIndexed(configuredDir, ids, at) {
  const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : [];
  if (list.length === 0) return { ok: true, value: 0, dir: configuredDir, storeId: '', fallback: false, reason: '' };
  return withStore(configuredDir, (db) => {
    const stmt = db.prepare('update messages set indexed_at = ? where id = ?');
    let changes = 0;
    for (const id of list) changes += Number(stmt.run(at, id).changes);
    return changes;
  });
}

/**
 * 写一条记忆。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{fromMsg?: number|null, toMsg: number, text: string, vec: Float32Array|number[]}} memory - 记忆。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为新记忆 id。
 */
export function insertMemory(configuredDir, memory) {
  const vec = memory.vec instanceof Float32Array ? memory.vec : Float32Array.from(memory.vec ?? []);
  const fromMsg = Number.isInteger(memory.fromMsg) ? memory.fromMsg : null;
  const toMsg = Number.isInteger(memory.toMsg) ? memory.toMsg : 0;
  const text = typeof memory.text === 'string' ? memory.text : '';
  return withStore(configuredDir, (db) => {
    const result = db
      .prepare('insert into memories(at, from_msg, to_msg, text, vec, dim) values (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), fromMsg, toMsg, text, toVectorBlob(vec), vec.length);
    return Number(result.lastInsertRowid);
  });
}

/**
 * 读记忆向量（新的在前），供检索打分。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number} [limit] - 最多读多少条。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为 `{id, at, fromMsg, toMsg, text, vec, dim}[]`。
 */
export function listMemoryVectors(configuredDir, limit = MAX_MEMORY_SCAN) {
  const cap = Math.min(MAX_MEMORY_SCAN, Math.max(1, Number.isInteger(limit) ? limit : MAX_MEMORY_SCAN));
  return withStore(configuredDir, (db) => {
    const rows = db
      .prepare('select id, at, from_msg, to_msg, text, vec, dim from memories order by id desc limit ?')
      .all(cap);
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      fromMsg: row.from_msg === null || row.from_msg === undefined ? null : Number(row.from_msg),
      toMsg: Number(row.to_msg),
      text: typeof row.text === 'string' ? row.text : '',
      vec: fromVectorBlob(row.vec),
      dim: Number(row.dim),
    }));
  });
}

/**
 * 记忆库状态：已建成几条、还有几条消息在排队等入库。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @returns {object} `{memories, pending, error?, reason?}`。
 */
export function memoryStats(configuredDir) {
  const result = withStore(configuredDir, (db) => ({
    memories: Number(db.prepare('select count(*) as c from memories').get().c),
    pending: Number(db
      .prepare("select count(*) as c from messages where role = 'assistant' and indexed_at is null and ingest_due_at is not null")
      .get().c),
  }));
  if (result.ok !== true) {
    return { memories: 0, pending: 0, dir: result.dir, error: result.error, reason: result.reason };
  }
  return { memories: result.value.memories, pending: result.value.pending, dir: result.dir, error: null };
}

// ── 屏幕记忆与窗口记录（屏幕陪看）──────────────────────────────────────

/**
 * 向量 → int8（体积省 4 倍；精度对 top-K 检索足够）。
 * 返回未签名字节（解码时 2 的补码还原）与反量化系数。
 * @param {Float32Array|number[]} vec - 向量。
 * @returns {{bytes: Uint8Array, scale: number}} 量化结果。
 */
export function quantizeInt8(vec) {
  const source = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  let max = 0;
  for (let i = 0; i < source.length; i += 1) {
    const abs = Math.abs(source[i]);
    if (abs > max) max = abs;
  }
  const scale = max === 0 ? 1 : max / 127;
  const bytes = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    let q = Math.round(source[i] / scale);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    bytes[i] = q & 0xff;
  }
  return { bytes, scale };
}

/**
 * int8 → 向量。
 * @param {Uint8Array|ArrayBuffer} blob - 字节。
 * @param {number} scale - 反量化系数。
 * @param {number} dim - 维度。
 * @returns {Float32Array} 向量。
 */
export function dequantizeInt8(blob, scale, dim) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const out = new Float32Array(dim);
  const factor = Number.isFinite(scale) ? scale : 1;
  for (let i = 0; i < dim && i < bytes.length; i += 1) {
    const raw = bytes[i];
    out[i] = (raw >= 128 ? raw - 256 : raw) * factor;
  }
  return out;
}

/** 本地日（YYYY-MM-DD），压缩分组与预筛用。 */
export function dayKey(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 写一条屏幕记忆。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{at?: number, app?: string, title?: string, kind?: string, text: string, frame?: string|null, vec: Float32Array|number[], subtitle?: string}} memory - 内容。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为新行 id。
 */
export function insertScreenMemory(configuredDir, memory) {
  const vec = memory.vec instanceof Float32Array ? memory.vec : Float32Array.from(memory.vec ?? []);
  const packed = quantizeInt8(vec);
  const at = Number.isFinite(memory.at) ? Math.round(memory.at) : Date.now();
  const kind = memory.kind === 'summary' ? 'summary' : 'raw';
  const text = typeof memory.text === 'string' ? memory.text.slice(0, 4000) : '';
  const app = typeof memory.app === 'string' ? memory.app.slice(0, 120) : '';
  const title = typeof memory.title === 'string' ? memory.title.slice(0, 400) : '';
  const frame = typeof memory.frame === 'string' && memory.frame !== '' ? memory.frame : null;
  const subtitle = typeof memory.subtitle === 'string' && memory.subtitle !== '' ? memory.subtitle.slice(0, 1000) : null;
  return withStore(configuredDir, (db) => Number(db
    .prepare('insert into screen_memories(at, app, title, kind, text, frame, vec, dim, scale, compressed, day, created_at, subtitle) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(at, app, title, kind, text, frame, packed.bytes, vec.length, packed.scale, 0, dayKey(at), Date.now(), subtitle).lastInsertRowid));
}

/**
 * 读屏幕记忆向量。**永远带 limit**（实测全表读 20 万行要 421 ms，预筛后 15 ms）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{limit?: number, kind?: string, day?: string, app?: string, since?: number, includeCompressed?: boolean}} [options] - 预筛条件。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为 `{id, at, app, title, kind, text, frame, vec, compressed, day}[]`。
 */
export function listScreenMemories(configuredDir, options = {}) {
  const limit = Math.min(5000, Math.max(1, Number.isInteger(options.limit) ? options.limit : 2000));
  const where = [];
  const params = [];
  if (options.kind === 'raw' || options.kind === 'summary') { where.push('kind = ?'); params.push(options.kind); }
  if (options.includeCompressed !== true) where.push('compressed = 0');
  if (typeof options.day === 'string' && options.day !== '') { where.push('day = ?'); params.push(options.day); }
  if (typeof options.app === 'string' && options.app !== '') { where.push('app = ?'); params.push(options.app); }
  if (Number.isFinite(options.since)) { where.push('at >= ?'); params.push(Math.round(options.since)); }
  const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`;
  return withStore(configuredDir, (db) => {
    const rows = db
      .prepare(`select id, at, app, title, kind, text, frame, vec, dim, scale, compressed, day, subtitle from screen_memories${clause} order by at desc limit ?`)
      .all(...params, limit);
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      app: typeof row.app === 'string' ? row.app : '',
      title: typeof row.title === 'string' ? row.title : '',
      kind: row.kind === 'summary' ? 'summary' : 'raw',
      text: typeof row.text === 'string' ? row.text : '',
      frame: typeof row.frame === 'string' ? row.frame : null,
      subtitle: typeof row.subtitle === 'string' ? row.subtitle : null,
      vec: dequantizeInt8(row.vec, Number(row.scale), Number(row.dim)),
      compressed: Number(row.compressed) === 1,
      day: typeof row.day === 'string' ? row.day : '',
    }));
  });
}

/**
 * 标记已压缩（压缩摘要用；**不删行**）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {number[]} ids - 行 id。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为改动条数。
 */
export function markScreenCompressed(configuredDir, ids) {
  const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : [];
  if (list.length === 0) return { ok: true, value: 0, dir: configuredDir, storeId: '', fallback: false, reason: '' };
  return withStore(configuredDir, (db) => {
    const stmt = db.prepare('update screen_memories set compressed = 1 where id = ?');
    let changes = 0;
    for (const id of list) changes += Number(stmt.run(id).changes);
    return changes;
  });
}

/**
 * 屏幕记忆状态（界面/自检用）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @returns {object} `{total, raw, summaries, uncompressed, today, frames}`。
 */
export function screenStats(configuredDir) {
  const result = withStore(configuredDir, (db) => {
    const total = Number(db.prepare('select count(*) as c from screen_memories').get().c);
    const raw = Number(db.prepare("select count(*) as c from screen_memories where kind = 'raw'").get().c);
    const summaries = Number(db.prepare("select count(*) as c from screen_memories where kind = 'summary'").get().c);
    const uncompressed = Number(db.prepare('select count(*) as c from screen_memories where compressed = 0').get().c);
    const today = Number(db.prepare('select count(*) as c from screen_memories where day = ?').get(dayKey(Date.now())).c);
    const frames = Number(db.prepare('select count(*) as c from window_events').get().c);
    return { total, raw, summaries, uncompressed, today, frames };
  });
  if (result.ok !== true) return { total: 0, raw: 0, summaries: 0, uncompressed: 0, today: 0, frames: 0, dir: result.dir, error: result.error };
  return { ...result.value, dir: result.dir, error: null };
}

/**
 * 记一次前台窗口变化（全量落库）。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{at?: number, hwnd?: number, process?: string, title?: string}} event - 变化。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为新行 id。
 */
export function insertWindowEvent(configuredDir, event) {
  const at = Number.isFinite(event.at) ? Math.round(event.at) : Date.now();
  const hwnd = Number.isFinite(event.hwnd) ? Math.round(event.hwnd) : null;
  const process = typeof event.process === 'string' ? event.process.slice(0, 120) : '';
  const title = typeof event.title === 'string' ? event.title.slice(0, 400) : '';
  return withStore(configuredDir, (db) => Number(db
    .prepare('insert into window_events(at, hwnd, process, title) values (?, ?, ?, ?)')
    .run(at, hwnd, process, title).lastInsertRowid));
}

/**
 * 查窗口记录（按时间/进程/标题关键字）——A 路线注入与界面共用这一套。
 * @param {unknown} configuredDir - 配置的数据目录。
 * @param {{from?: number, to?: number, process?: string, q?: string, limit?: number}} [options] - 查询条件。
 * @returns {ReturnType<typeof withStore>} 成功时 value 为 `{id, at, hwnd, process, title}[]`（时间升序）。
 */
export function queryWindowEvents(configuredDir, options = {}) {
  const limit = Math.min(2000, Math.max(1, Number.isInteger(options.limit) ? options.limit : 200));
  const where = [];
  const params = [];
  if (Number.isFinite(options.from)) { where.push('at >= ?'); params.push(Math.round(options.from)); }
  if (Number.isFinite(options.to)) { where.push('at <= ?'); params.push(Math.round(options.to)); }
  if (typeof options.process === 'string' && options.process !== '') { where.push('process = ?'); params.push(options.process); }
  if (typeof options.q === 'string' && options.q !== '') { where.push('title like ?'); params.push(`%${options.q}%`); }
  const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`;
  return withStore(configuredDir, (db) => db
    .prepare(`select id, at, hwnd, process, title from window_events${clause} order by at asc limit ?`)
    .all(...params, limit)
    .map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      hwnd: row.hwnd === null || row.hwnd === undefined ? null : Number(row.hwnd),
      process: typeof row.process === 'string' ? row.process : '',
      title: typeof row.title === 'string' ? row.title : '',
    })));
}


/**
 * @local/chat-widget —— edge-tts 的 `Sec-MS-GEC` **v2** 令牌算法（纯 JS 移植）。
 *
 * ## 为什么需要它
 *
 * 微软的朗读服务在 2026-10 换了令牌格式：从「把时间戳拼 token 做一次 SHA-256」变成
 * **`Sec-MS-GEC v2` = `<16 位 CS64>-<64 位自定义 SHA256>`**，并且版本号要写成 `2-<Chrome 版本>`。
 * 旧算法（v1）现在一律 403 —— 这就是我第一版直接照公开老实现写、连不上（1006/403）的原因。
 *
 * 实现来源：PyPI 上 `edge-tts 7.3.1` 的 `edge_tts/drm.py`（MIT），这里逐行机械移植，
 * 用该包在同一时间戳下算出的向量做单元测试（`check-tts.mjs` 里有断言）。
 *
 * 注意：里面的 `sha256Digest` **不是标准 SHA-256**（初始状态与消息调度都被改写/预计算过），
 * 所以不能换成 `node:crypto`，必须按原样移植。
 *
 * @module @local/chat-widget/host/edge-token
 */

/** 掩码（等价 Python 的 & 0xFFFFFFFF）。 */
const MASK = 0xFFFFFFFF;

/** Windows 文件时间纪元偏移（秒）。 */
const WIN_EPOCH = 11644473600;

/** 微软朗读服务的固定 client token。 */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/** SHA-256 初始状态。 */
const SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];

/** 预计算到第 14 轮的中间状态。 */
const SHA256_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];

/** 预计算的消息调度。 */
const SHA256_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
];

/** SHA-256 轮常量。 */
const ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];

/** 第 14 轮被改写过的那份常量表。 */
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const BLOCK_CONSTANTS = [
  ...ROUND_CONSTANTS.slice(0, 14), SHA256_ADJUSTMENT, ...ROUND_CONSTANTS.slice(15),
];

const SIGMA0_ADJUSTMENT = 0x059C0B80;
const SIGMA1_ADJUSTMENT = 0x000B92C0;

/** CS64 用的系数表。 */
const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;

/** 32 位无符号乘法（低 32 位）。 */
const mul = (a, b) => Math.imul(a, b) >>> 0;

/** 32 位循环左移 16。 */
const rol16 = (value) => (((value << 16) | (value >>> 16)) >>> 0) & MASK;

/** SHA-256 的小写 sigma0（一次截断）。 */
function sigma0(value) {
  return (((value >>> 7) | (value << 25)) ^ ((value >>> 18) | (value << 14)) ^ (value >>> 3)) >>> 0;
}

/** SHA-256 的小写 sigma1（一次截断）。 */
function sigma1(value) {
  return (((value >>> 17) | (value << 15)) ^ ((value >>> 19) | (value << 13)) ^ (value >>> 10)) >>> 0;
}

/** 大写的 Σ0。 */
const bigSigma0 = (x) => (((x >>> 2) | (x << 30)) ^ ((x >>> 13) | (x << 19)) ^ ((x >>> 22) | (x << 10))) >>> 0;
/** 大写的 Σ1。 */
const bigSigma1 = (x) => (((x >>> 6) | (x << 26)) ^ ((x >>> 11) | (x << 21)) ^ ((x >>> 25) | (x << 7))) >>> 0;

/**
 * 跑 SHA-256 轮（可选择从第 `firstRound` 轮接着跑）。
 *
 * @param {number[]} state - 8 个工作寄存器。
 * @param {number[]} words - 64 个消息字。
 * @param {number} [firstRound] - 从第几轮开始（14 = 复用预计算状态）。
 * @returns {number[]} 跑完后的 8 个寄存器。
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? BLOCK_CONSTANTS : ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index += 1) {
    const t1 = (h + bigSigma1(e) + (g ^ (e & (f ^ g))) + constants[index] + words[index]) >>> 0;
    const t2 = (bigSigma0(a) + ((a & b) | (c & (a | b)))) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

/**
 * 扩展消息调度（从第 `firstWord` 个字开始）。
 *
 * @param {number[]} words - 长度 64 的数组（就地修改）。
 * @param {number} [firstWord] - 起始下标。
 * @returns {void}
 */
function expandSchedule(words, firstWord = 16) {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2];
    const y = words[index - 15];
    words[index] = (sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]) >>> 0;
  }
}

/**
 * 计算初始状态（前 7 个字节是预计算输入）。
 *
 * @param {Buffer} data - 至少 7 字节。
 * @returns {number[]} 8 个寄存器。
 */
function sha256Init(data) {
  const words = new Array(16).fill(0);
  words[14] = ((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0;
  words[15] = ((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0;
  words.length = 16;
  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value = (value + (index === 16 ? (sigma1(words[index - 2]) ^ SIGMA1_ADJUSTMENT) : sigma1(words[index - 2]))) >>> 0;
    }
    if (index - 7 >= 14) value = (value + words[index - 7]) >>> 0;
    if (index - 15 >= 14) {
      value = (value + (index === 29 ? (sigma0(words[index - 15]) ^ SIGMA0_ADJUSTMENT) : sigma0(words[index - 15]))) >>> 0;
    }
    words.push(value >>> 0);
  }
  words.push((
    sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14]
    + SHA256_ADJUSTMENT - ROUND_CONSTANTS[14]
  ) >>> 0);
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return working.map((value, index) => (value + SHA256_INITIAL[index]) >>> 0);
}

/**
 * 自定义 SHA-256 摘要（**不是**标准 SHA-256）。
 *
 * @param {Buffer} data - 输入（至少 7 字节）。
 * @returns {Buffer} 32 字节摘要。
 */
export function sha256Digest(data) {
  if (data.length < 7) throw new Error('token salt 至少要 7 字节');
  const length = 57 + data.length;
  // 注意：Python 的 % 对负数返回非负，JS 会返回负数 —— 这里要手动归一
  const padLength = (((55 - length) % 64) + 64) % 64;
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(padLength),
    (() => {
      const tail = Buffer.alloc(8);
      const bits = BigInt(length) * 8n;
      tail.writeBigUInt64BE(bits);
      return tail;
    })(),
  ]);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const block = padded.subarray(offset, offset + 64);
    const words = new Array(16);
    for (let i = 0; i < 16; i += 1) words[i] = block.readUInt32BE(i * 4);
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = working.map((value, index) => (value + state[index]) >>> 0);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(state[i], i * 4);
  return out;
}

/**
 * CS64 摘要（两个 32 位字）。
 *
 * @param {Buffer} data - 输入。
 * @param {Buffer} digest - `sha256Digest` 的结果。
 * @returns {{hi:number, lo:number}} 两个字（对应 Python 返回的元组）。
 */
function cs64Digest(data, digest) {
  let keyA = digest.readUInt32LE(0) | 1;
  let keyB = digest.readUInt32LE(4) | 1;
  keyA >>>= 0;
  keyB >>>= 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];

  const terms = [];
  const offsets = [];
  for (let i = 0; i < CS64_COEFFICIENTS.length; i += 1) {
    terms.push(mul(CS64_COEFFICIENTS[i][0], factors[i % 2]));
    offsets.push(CS64_COEFFICIENTS[i][1]);
  }

  // b'\x00' + data，**尾部补零**到 4 的倍数，按小端拆 32 位字；字数为奇数再补一个 0。
  // （注意：是补零不是截断 —— 截断会把最后几个字节丢掉，算出来的 CS64 就和官方对不上。）
  const raw = Buffer.concat([Buffer.from([0]), data]);
  const rem = raw.length % 4;
  const padded = rem === 0 ? raw : Buffer.concat([raw, Buffer.alloc(4 - rem)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2 === 1) words.push(0);

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = mul(t, 0x76F50F34);
    swapAcc = (swapAcc + ((mul(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = mul(t, 0x1881CE3C);
    swapLast = (mul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xCF98B111);
    state = mul(rol16(state), 0x87085B9F);
    state = mul(rol16(state), 0x12CEB96D);
    state = mul(rol16(state), 0x257E1D83);
    acc = (acc + state) >>> 0;

    t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xA27416F5);
    t = mul(rol16(t), 0xD38396FF);
    state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = (acc + state) >>> 0;
  }
  return { hi: (swapLast ^ state) >>> 0, lo: (swapAcc ^ acc) >>> 0 };
}

/**
 * 算 `Sec-MS-GEC` v2 令牌。
 *
 * @param {number} [unixTimestamp] - 指定时间戳（测试用）；不给就用当前时间。
 * @returns {string} 形如 `<16 hex>-<64 hex>`。
 */
export function generateSecMsGecV2(unixTimestamp) {
  let ticks = Number.isFinite(Number(unixTimestamp)) ? Number(unixTimestamp) : Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const data = Buffer.from(`${Math.trunc(ticks)}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = sha256Digest(data);
  const { hi, lo } = cs64Digest(data, digest);
  const cs64 = Buffer.alloc(8);
  cs64.writeUInt32LE(hi, 0);
  cs64.writeUInt32LE(lo, 4);
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

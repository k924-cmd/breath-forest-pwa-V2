// 一次性脚本：中心裁剪 + alpha 预乘双线性缩放 PNG（零依赖，Node 内置 zlib）
// 正确解码 PNG Sub filter（type 1），透明像素用预乘 alpha 避免黑色噪点
// 用法：node _gen_icons.js <输入png> <输出png> <尺寸> [maskable]
// maskable=1 时内容内缩到 76% 居中，四周留白（白底）
const fs = require('fs');
const zlib = require('zlib');

// ---- PNG 解析 ----
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function readPNG(buf) {
  let pos = 8, w = 0, h = 0, colortype = 0, bitdepth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitdepth = data[8]; colortype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (bitdepth !== 8) throw new Error('unsupported bit depth: ' + bitdepth);
  const bpp = colortype === 6 ? 4 : colortype === 2 ? 3 : colortype === 4 ? 2 : colortype === 0 ? 1 : colortype === 3 ? 1 : 0;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  // 逆滤波：Sub(1) / Up(2) / Average(3) / Paeth(4)
  const out = Buffer.alloc(h * stride);
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowStart + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: val = cur + paeth(a, b, c); break;
        default: throw new Error('unknown filter ' + filter);
      }
      out[y * stride + x] = val & 0xFF;
    }
  }
  return { w, h, bpp, raw: out };
}
function encodePNG(width, height, raw, bpp) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * bpp;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 裁剪中心方形 ----
function cropSquareCenter(img) {
  const side = Math.min(img.w, img.h);
  const sx = Math.floor((img.w - side) / 2);
  const sy = Math.floor((img.h - side) / 2);
  const out = Buffer.alloc(side * side * img.bpp);
  const stride = img.w * img.bpp;
  for (let y = 0; y < side; y++) {
    img.raw.copy(out, y * side * img.bpp, (sy + y) * stride + sx * img.bpp, (sy + y) * stride + (sx + side) * img.bpp);
  }
  return { w: side, h: side, bpp: img.bpp, raw: out };
}

// ---- alpha 预乘双线性缩放 ----
function resize(img, dw, dh) {
  const { w: sw, h: sh, bpp, raw } = img;
  const hasAlpha = bpp === 4;
  const out = Buffer.alloc(dw * dh * bpp);
  // 先转预乘
  const premul = new Float64Array(sw * sh * bpp);
  for (let i = 0; i < sw * sh; i++) {
    const o = i * bpp;
    let a = 255;
    if (hasAlpha) { a = raw[o + 3]; premul[o + 3] = a; }
    const inv = a / 255;
    for (let c = 0; c < (hasAlpha ? 3 : bpp); c++) premul[o + c] = raw[o + c] * inv;
  }
  function sample(x, y, c) {
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(y)));
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const p00 = premul[(y0 * sw + x0) * bpp + c];
    const p10 = premul[(y0 * sw + x1) * bpp + c];
    const p01 = premul[(y1 * sw + x0) * bpp + c];
    const p11 = premul[(y1 * sw + x1) * bpp + c];
    return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
  }
  for (let y = 0; y < dh; y++) {
    const gy = (y + 0.5) * sh / dh - 0.5;
    for (let x = 0; x < dw; x++) {
      const gx = (x + 0.5) * sw / dw - 0.5;
      const o = (y * dw + x) * bpp;
      for (let c = 0; c < (hasAlpha ? 3 : bpp); c++) {
        out[o + c] = Math.round(sample(gx, gy, c));
      }
      if (hasAlpha) {
        const a = sample(gx, gy, 3);
        out[o + 3] = Math.round(a);
        if (a > 0) {
          const ia = 255 / a;
          out[o] = Math.min(255, Math.round(out[o] * ia));
          out[o + 1] = Math.min(255, Math.round(out[o + 1] * ia));
          out[o + 2] = Math.min(255, Math.round(out[o + 2] * ia));
        }
      }
    }
  }
  return { w: dw, h: dh, bpp, raw: out };
}

// ---- 内缩居中到白底（maskable 安全区）----
function insetToWhite(img, ratio) {
  const side = Math.floor(img.w * ratio);
  const off = Math.floor((img.w - side) / 2);
  const out = Buffer.alloc(img.w * img.w * img.bpp, 255); // 白底（含 alpha 255）
  const stride = img.w * img.bpp;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const s = (y * stride + x * img.bpp);
      const d = ((off + y) * stride + (off + x) * img.bpp);
      out[d] = img.raw[s]; out[d + 1] = img.raw[s + 1]; out[d + 2] = img.raw[s + 2];
      if (img.bpp === 4) out[d + 3] = img.raw[s + 3];
    }
  }
  return { w: img.w, h: img.w, bpp: img.bpp, raw: out };
}

// ---- main ----
const [, , inPath, outPath, sizeStr, maskableStr] = process.argv;
const size = parseInt(sizeStr, 10);
const src = readPNG(fs.readFileSync(inPath));
let img = cropSquareCenter(src);
if (maskableStr === '1') img = insetToWhite(img, 0.76);
const scaled = resize(img, size, size);
fs.writeFileSync(outPath, encodePNG(scaled.w, scaled.h, scaled.raw, scaled.bpp));
console.log(`wrote ${outPath} ${scaled.w}x${scaled.h} bpp=${scaled.bpp} ${fs.statSync(outPath).size} bytes`);

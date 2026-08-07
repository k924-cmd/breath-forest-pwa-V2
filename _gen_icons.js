// 一次性脚本：中心裁剪 + 双线性缩放 PNG（零依赖，Node 内置 zlib）
// 用法：node _gen_icons.js <输入png> <输出png> <尺寸> [maskable]
// maskable=1 时内容内缩到 76% 居中，四周留白
const fs = require('fs');
const zlib = require('zlib');

// ---- PNG 解析/编码 ----
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
  let pos = 8, w = 0, h = 0, colortype = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colortype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colortype === 2 ? 3 : colortype === 6 ? 4 : colortype === 4 ? 2 : colortype === 0 ? 1 : 0;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { w, h, bpp, raw };
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
  const idatData = zlib.deflateSync(filtered, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 裁剪中心方形 ----
function cropSquareCenter(img) {
  const side = Math.min(img.w, img.h);
  const sx = Math.floor((img.w - side) / 2);
  const sy = Math.floor((img.h - side) / 2);
  const out = Buffer.alloc(side * side * img.bpp);
  const stride = img.w * img.bpp;
  for (let y = 0; y < side; y++) {
    const srcStart = (sy + y) * (1 + stride) + 1 + sx * img.bpp; // 跳过 filter 字节
    img.raw.copy(out, y * side * img.bpp, srcStart, srcStart + side * img.bpp);
  }
  return { w: side, h: side, bpp: img.bpp, raw: out };
}

// ---- 双线性缩放 ----
function resize(img, dw, dh) {
  const { w: sw, h: sh, bpp, raw } = img;
  const out = Buffer.alloc(dw * dh * bpp);
  for (let y = 0; y < dh; y++) {
    const gy = ((y + 0.5) * sh / dh) - 0.5;
    const y0 = Math.max(0, Math.floor(gy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < dw; x++) {
      const gx = ((x + 0.5) * sw / dw) - 0.5;
      const x0 = Math.max(0, Math.floor(gx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = gx - x0;
      for (let c = 0; c < bpp; c++) {
        const p00 = raw[(y0 * sw + x0) * bpp + c];
        const p10 = raw[(y0 * sw + x1) * bpp + c];
        const p01 = raw[(y1 * sw + x0) * bpp + c];
        const p11 = raw[(y1 * sw + x1) * bpp + c];
        const v = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
        out[(y * dw + x) * bpp + c] = Math.round(v);
      }
    }
  }
  return { w: dw, h: dh, bpp, raw: out };
}

// ---- 内缩居中（maskable 安全区）----
function inset(img, ratio) {
  const side = Math.floor(img.w * ratio);
  const off = Math.floor((img.w - side) / 2);
  const out = Buffer.alloc(img.w * img.w * img.bpp, 255); // 白底
  const srcStride = img.w * img.bpp;
  for (let y = 0; y < side; y++) {
    img.raw.copy(out, (off + y) * srcStride + off * img.bpp, (y) * srcStride, (y) * srcStride + side * img.bpp);
  }
  return { w: img.w, h: img.w, bpp: img.bpp, raw: out };
}

// ---- main ----
const [, , inPath, outPath, sizeStr, maskableStr] = process.argv;
const size = parseInt(sizeStr, 10);
const src = readPNG(fs.readFileSync(inPath));
let img = cropSquareCenter(src);
if (maskableStr === '1') img = inset(img, 0.76);
const scaled = resize(img, size, size);
fs.writeFileSync(outPath, encodePNG(scaled.w, scaled.h, scaled.raw, scaled.bpp));
console.log(`wrote ${outPath} ${scaled.w}x${scaled.h} bpp=${scaled.bpp} ${fs.statSync(outPath).size} bytes`);

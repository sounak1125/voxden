'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SCALE = 4;

const COLORS = {
  inkTop: { r: 19, g: 24, b: 28 },
  inkBottom: { r: 8, g: 11, b: 14 },
  tile: { r: 18, g: 24, b: 27 },
  tileEdge: { r: 255, g: 255, b: 255 },
  mintTop: { r: 193, g: 248, b: 209 },
  mintBottom: { r: 104, g: 213, b: 147 },
  paper: { r: 250, g: 250, b: 250 },
  paperRule: { r: 224, g: 226, b: 225 },
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function lerpColor(a, b, t) {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  };
}

function blend(base, overlay, alpha) {
  return {
    r: lerp(base.r, overlay.r, alpha),
    g: lerp(base.g, overlay.g, alpha),
    b: lerp(base.b, overlay.b, alpha),
  };
}

function createCanvas(width, height, painter) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = painter(x, y, width, height);
      const offset = (y * width + x) * 3;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
    }
  }
  return pixels;
}

function pixelAt(pixels, width, x, y) {
  const offset = (y * width + x) * 3;
  return { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] };
}

function setPixel(pixels, width, x, y, color, alpha = 1) {
  const offset = (y * width + x) * 3;
  const base = { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] };
  const out = blend(base, color, alpha);
  pixels[offset] = out.r;
  pixels[offset + 1] = out.g;
  pixels[offset + 2] = out.b;
}

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius;
}

function drawRoundedRect(pixels, width, height, rect, radius, color, alpha = 1) {
  const [left, top, right, bottom] = rect.map(Math.round);
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(width - 1, right); x += 1) {
      if (roundedRectContains(x, y, left, top, right, bottom, radius)) {
        setPixel(pixels, width, x, y, color, alpha);
      }
    }
  }
}

function drawRoundedBorder(pixels, width, height, rect, radius, color, alpha, thickness) {
  drawRoundedRect(pixels, width, height, rect, radius, color, alpha);
  drawRoundedRect(
    pixels,
    width,
    height,
    [rect[0] + thickness, rect[1] + thickness, rect[2] - thickness, rect[3] - thickness],
    Math.max(1, radius - thickness),
    COLORS.tile,
    1,
  );
}

function drawMark(pixels, width, height, cx, cy, unit) {
  const bars = [
    { x: -4.8, h: 2.65 },
    { x: -2.4, h: 4.65 },
    { x: 0, h: 7.3 },
    { x: 2.4, h: 4.65 },
  ];
  const barWidth = 1.35 * unit;
  for (const bar of bars) {
    const h = bar.h * unit;
    const top = cy - h / 2;
    const bottom = cy + h / 2;
    const left = cx + bar.x * unit - barWidth / 2;
    const right = left + barWidth;
    const topColor = COLORS.mintTop;
    const bottomColor = COLORS.mintBottom;
    for (let y = Math.floor(top); y <= Math.ceil(bottom); y += 1) {
      const color = lerpColor(topColor, bottomColor, clamp((y - top) / Math.max(1, h)));
      for (let x = Math.floor(left); x <= Math.ceil(right); x += 1) {
        if (roundedRectContains(x, y, left, top, right, bottom, barWidth / 2)) {
          setPixel(pixels, width, x, y, color, 1);
        }
      }
    }
  }

  const segmentX = cx + 4.8 * unit;
  const segmentHeight = 0.56 * unit;
  const segmentGap = 0.33 * unit;
  const groupHeight = segmentHeight * 4 + segmentGap * 3;
  const firstTop = cy - groupHeight / 2;
  for (let index = 0; index < 4; index += 1) {
    const top = firstTop + index * (segmentHeight + segmentGap);
    const bottom = top + segmentHeight;
    const left = segmentX - barWidth / 2;
    const right = segmentX + barWidth / 2;
    const color = lerpColor(
      COLORS.mintTop,
      COLORS.mintBottom,
      clamp((top - firstTop) / Math.max(1, groupHeight)),
    );
    drawRoundedRect(
      pixels,
      width,
      height,
      [left, top, right, bottom],
      index === 0 || index === 3 ? barWidth / 2 : 0.08 * unit,
      color,
      1,
    );
  }
}

function drawSidebar(width, height) {
  const pixels = createCanvas(width, height, (x, y, w, h) => {
    const base = lerpColor(COLORS.inkTop, COLORS.inkBottom, y / h);
    const dx = (x - w * 0.52) / (w * 0.62);
    const dy = (y - h * 0.34) / (h * 0.3);
    const glow = clamp(1 - Math.sqrt(dx * dx + dy * dy)) * 0.075;
    return blend(base, COLORS.mintBottom, glow);
  });

  const tileSize = 84 * SCALE;
  const tileLeft = (width - tileSize) / 2;
  const tileTop = 68 * SCALE;
  const tileRect = [tileLeft, tileTop, tileLeft + tileSize, tileTop + tileSize];
  drawRoundedBorder(pixels, width, height, tileRect, 22 * SCALE, COLORS.tileEdge, 0.075, SCALE);
  drawMark(pixels, width, height, width / 2, tileTop + tileSize / 2, 7.6 * SCALE);

  drawRoundedRect(
    pixels,
    width,
    height,
    [48 * SCALE, 184 * SCALE, 116 * SCALE, 186 * SCALE],
    SCALE,
    COLORS.mintBottom,
    0.55,
  );
  drawRoundedRect(
    pixels,
    width,
    height,
    [62 * SCALE, 194 * SCALE, 102 * SCALE, 196 * SCALE],
    SCALE,
    COLORS.tileEdge,
    0.12,
  );

  const dotY = 276 * SCALE;
  for (let index = 0; index < 3; index += 1) {
    const x = (74 + index * 8) * SCALE;
    drawRoundedRect(
      pixels,
      width,
      height,
      [x, dotY, x + 3 * SCALE, dotY + 3 * SCALE],
      1.5 * SCALE,
      index === 1 ? COLORS.mintBottom : COLORS.tileEdge,
      index === 1 ? 0.62 : 0.13,
    );
  }
  return pixels;
}

function drawHeader(width, height) {
  const pixels = createCanvas(width, height, (x, y, w, h) => {
    const base = COLORS.paper;
    return y >= h - SCALE ? COLORS.paperRule : base;
  });

  const size = 36 * SCALE;
  const left = width - 48 * SCALE;
  const top = 10 * SCALE;
  const rect = [left, top, left + size, top + size];
  drawRoundedBorder(pixels, width, height, rect, 10 * SCALE, { r: 0, g: 0, b: 0 }, 0.1, SCALE);
  drawMark(pixels, width, height, left + size / 2, top + size / 2, 3.1 * SCALE);
  return pixels;
}

function downsample(pixels, width, height, factor) {
  const outWidth = Math.round(width / factor);
  const outHeight = Math.round(height / factor);
  const output = Buffer.alloc(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const color = pixelAt(pixels, width, x * factor + sx, y * factor + sy);
          r += color.r;
          g += color.g;
          b += color.b;
        }
      }
      const samples = factor * factor;
      const offset = (y * outWidth + x) * 3;
      output[offset] = Math.round(r / samples);
      output[offset + 1] = Math.round(g / samples);
      output[offset + 2] = Math.round(b / samples);
    }
  }
  return { pixels: output, width: outWidth, height: outHeight };
}

function writeBmp24(filePath, width, height, pixels) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelDataSize);
  buffer.write('BM', 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelDataSize, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);

  let offset = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3;
      buffer[offset] = pixels[source + 2];
      buffer[offset + 1] = pixels[source + 1];
      buffer[offset + 2] = pixels[source];
      offset += 3;
    }
    while ((offset - 54) % rowSize !== 0) buffer[offset++] = 0;
  }
  fs.writeFileSync(filePath, buffer);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sidebarLarge = drawSidebar(164 * SCALE, 314 * SCALE);
  const sidebar = downsample(sidebarLarge, 164 * SCALE, 314 * SCALE, SCALE);
  writeBmp24(path.join(OUT_DIR, 'installerSidebar.bmp'), sidebar.width, sidebar.height, sidebar.pixels);

  const headerLarge = drawHeader(150 * SCALE, 57 * SCALE);
  const header = downsample(headerLarge, 150 * SCALE, 57 * SCALE, SCALE);
  writeBmp24(path.join(OUT_DIR, 'installerHeader.bmp'), header.width, header.height, header.pixels);

  console.log('Wrote build/installerSidebar.bmp (164x314, 24-bit)');
  console.log('Wrote build/installerHeader.bmp (150x57, 24-bit)');
}

main();

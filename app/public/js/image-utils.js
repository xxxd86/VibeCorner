// image-utils.js — 本地图片压缩 + 质检指标。全部在浏览器完成，不上传原图。
// 读取文件 → createImageBitmap → 离屏 canvas 压到长边 ≤1280 → jpeg 0.86
// metrics: brightness(0-255 平均亮度) / contrast(亮度标准差) / sharpness(灰度 3×3 拉普拉斯方差) / width / height / bytes

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.86;

const THRESHOLDS = {
  dark: 45, // brightness < 45 视为过暗
  blurry: 35, // sharpness < 35 视为偏糊
  small: 640, // width < 640 视为太小
};

function fitSize(width, height, maxEdge = MAX_EDGE) {
  const longEdge = Math.max(width, height) || 1;
  const scale = Math.min(1, maxEdge / longEdge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读不出来，换一张 jpg / png 试试'));
    img.src = url;
  });
}

async function loadSource(file) {
  const type = file && file.type ? file.type : '';
  if (typeof createImageBitmap === 'function' && /^image\//.test(type || 'image/')) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* 退回 <img> 路径 */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await loadImageElement(url);
  } finally {
    // 图片解码后即可释放；Image 元素已持有数据
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function sourceSize(source) {
  return {
    width: Number(source.width || source.naturalWidth || 0),
    height: Number(source.height || source.naturalHeight || 0),
  };
}

/** 灰度 3×3 拉普拉斯方差 + 亮度均值 / 标准差 */
function measurePixels(ctx, width, height, dataUrl) {
  const data = ctx.getImageData(0, 0, width, height).data;
  const total = width * height;
  const gray = new Float32Array(total);

  let sum = 0;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    gray[i] = luma;
    sum += luma;
  }
  const brightness = total ? sum / total : 0;

  let variance = 0;
  for (let i = 0; i < total; i++) {
    const d = gray[i] - brightness;
    variance += d * d;
  }
  const contrast = total ? Math.sqrt(variance / total) : 0;

  // 拉普拉斯：中心 -4，上下左右各 1（跳过最外圈）
  let lapSum = 0;
  let lapSqSum = 0;
  let lapCount = 0;
  if (width > 2 && height > 2) {
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        const lap = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
        lapSum += lap;
        lapSqSum += lap * lap;
        lapCount++;
      }
    }
  }
  let sharpness = 0;
  if (lapCount) {
    const mean = lapSum / lapCount;
    sharpness = lapSqSum / lapCount - mean * mean;
  }

  const bytes = Math.round((String(dataUrl || '').length * 3) / 4);

  return {
    brightness: Math.round(brightness * 10) / 10,
    contrast: Math.round(contrast * 10) / 10,
    sharpness: Math.round(sharpness * 10) / 10,
    width,
    height,
    bytes,
  };
}

function encodeSource(source, options = {}) {
  const maxEdge = Number(options.maxEdge) || MAX_EDGE;
  const quality = Number(options.quality) || JPEG_QUALITY;
  const withMetrics = options.metrics !== false;
  const { width: srcW, height: srcH } = sourceSize(source);
  if (!srcW || !srcH) throw new Error('图片尺寸读不出来，换一张 jpg / png 试试');
  const size = fitSize(srcW, srcH, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: withMetrics });
  if (!ctx) throw new Error('浏览器不支持 canvas，换 Edge / Chrome 再试');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, size.width, size.height);

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  } catch {
    throw new Error('这张图无法压缩（可能是跨域图），换一张本地照片试试');
  }
  const metrics = withMetrics ? measurePixels(ctx, size.width, size.height, dataUrl) : null;
  return { dataUrl, width: size.width, height: size.height, metrics };
}

/**
 * 读取文件 → 压缩 → 指标。
 * @param {File|Blob} file
 * @returns {Promise<{dataUrl:string,width:number,height:number,metrics:object}>}
 */
export async function prepareImage(file) {
  if (!file) throw new Error('没有拿到图片文件');
  const source = await loadSource(file);
  try {
    return encodeSource(source);
  } finally {
    if (source && typeof source.close === 'function') {
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 按 URL 读取（同源图片；demo 图和大图预览用）。
 * @param {string} url
 */
export async function prepareFromUrl(url) {
  if (!url) throw new Error('图片地址为空');
  const img = await loadImageElement(url);
  return encodeSource(img);
}

/**
 * 家庭分享专用缩略图：长边 900 / jpeg 0.82（分享页拿不到原图）。
 * 接受 URL 字符串或 File/Blob；复用同一套压缩逻辑，不算质检指标。
 * @param {string|File|Blob} source
 * @returns {Promise<{dataUrl:string,width:number,height:number}>}
 */
export async function prepareShareThumb(source) {
  if (!source) throw new Error('没有可以生成缩略图的照片');
  if (typeof source === 'string') {
    const img = await loadImageElement(source);
    return encodeSource(img, { maxEdge: 900, quality: 0.82, metrics: false });
  }
  const bitmap = await loadSource(source);
  try {
    return encodeSource(bitmap, { maxEdge: 900, quality: 0.82, metrics: false });
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 本地先拦：过暗 / 偏糊 / 太小。给中文 hint，block 级建议重拍，warn 级可继续。
 * @param {{brightness?:number,sharpness?:number,width?:number}} metrics
 * @returns {Array<{code:string,label:string,hint:string,severity:'block'|'warn'}>}
 */
export function localIssues(metrics) {
  const issues = [];
  if (!metrics || typeof metrics !== 'object') return issues;

  if (typeof metrics.brightness === 'number' && metrics.brightness < THRESHOLDS.dark) {
    issues.push({
      code: 'dark',
      label: '照片太暗',
      hint: '开一盏灯，或把窗帘拉开再拍。暗照片里 AI 看不清落点，返回的方向会很虚。',
      severity: 'block',
    });
  }
  if (typeof metrics.sharpness === 'number' && metrics.sharpness < THRESHOLDS.blurry) {
    issues.push({
      code: 'blurry',
      label: '照片有点糊',
      hint: '手机靠在桌沿上稳住 1 秒再按快门，别用数码变焦；手抖会让尺寸判断失准。',
      severity: 'warn',
    });
  }
  if (typeof metrics.width === 'number' && metrics.width < THRESHOLDS.small) {
    issues.push({
      code: 'small',
      label: '照片太小',
      hint: '用手机原生相机拍，别用微信 / 截图压缩过的图，墙和地面的交界要看得清。',
      severity: 'warn',
    });
  }
  return issues;
}

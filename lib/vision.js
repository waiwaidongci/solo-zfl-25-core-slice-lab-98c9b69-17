// Image-quality helpers operating on decoded RGBA frames.
import crypto from "node:crypto";

export function toGray(img, step = 1) {
  const { width, height, data } = img;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      gray[y * width + x] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
  }
  return gray;
}

// Variance of the 4-neighbour Laplacian: sharp micrographs have high-frequency
// grain/edges, defocused images collapse toward zero.
export function laplacianVariance(img) {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return 0;
  const g = toGray(img);
  let sum = 0;
  const values = new Float64Array((w - 2) * (h - 2));
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      values[n++] = lap;
      sum += lap;
    }
  }
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    acc += d * d;
  }
  return acc / n;
}

export function imageHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

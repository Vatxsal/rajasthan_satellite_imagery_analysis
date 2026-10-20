/**
 * Generates a deterministic canvas image used as the imagery overlay
 * placeholder. Runs in the browser only (called from the map after mount).
 */
export function createPlaceholderImageryUrl(size = 512): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve("");

  ctx.fillStyle = "#C9C4B8";
  ctx.fillRect(0, 0, size, size);

  // Blocky pseudo-terrain cells in muted earth/neutral tones.
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const tones = ["#B7B1A3", "#A8A493", "#C4BFAF", "#9EA392", "#CFC9B8", "#AAA290"];
  for (let i = 0; i < 160; i++) {
    const x = Math.floor(rnd() * 16) * (size / 16);
    const y = Math.floor(rnd() * 16) * (size / 16);
    ctx.fillStyle = tones[Math.floor(rnd() * tones.length)];
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x, y, size / 16, size / 16);
  }
  ctx.globalAlpha = 1;

  // Hairline grid.
  ctx.strokeStyle = "rgba(27, 29, 34, 0.12)";
  ctx.lineWidth = 1;
  const step = size / 8;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(27, 29, 34, 0.72)";
  ctx.textAlign = "center";
  ctx.font = "600 22px system-ui, sans-serif";
  ctx.fillText("Imagery overlay", size / 2, size / 2 - 6);
  ctx.font = "400 13px system-ui, sans-serif";
  ctx.fillStyle = "rgba(107, 110, 118, 0.95)";
  ctx.fillText("preview raster", size / 2, size / 2 + 16);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob ? URL.createObjectURL(blob) : "");
    }, "image/png");
  });
}

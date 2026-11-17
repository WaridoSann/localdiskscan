const palette = ["#326954", "#3c5873", "#5b4c78", "#725b40", "#3d6369", "#58644b"];

export function layout(items, width, height) {
  items = items.filter(item => Number.isFinite(item.size) && item.size > 0)
    .slice().sort((a, b) => b.size - a.size);
  if (!items.length || width <= 0 || height <= 0) return [];
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const factor = width * height / total;
  const remaining = items.map(item => ({ item, area: item.size * factor }));
  const tiles = [];
  let x = 0;
  let y = 0;
  let row = [];
  let sum = 0;
  let worst = Infinity;

  function placeRow() {
    const vertical = width >= height;
    const strip = sum / (vertical ? height : width);
    let offset = 0;
    for (const entry of row) {
      const length = entry.area / strip;
      tiles.push(vertical
        ? { item: entry.item, x, y: y + offset, width: strip, height: length }
        : { item: entry.item, x: x + offset, y, width: length, height: strip });
      offset += length;
    }
    if (vertical) { x += strip; width -= strip; }
    else { y += strip; height -= strip; }
    row = [];
    sum = 0;
    worst = Infinity;
  }

  for (const entry of remaining) {
    const side = Math.min(width, height);
    const area = sum + entry.area;
    const min = Math.min(row.at(-1)?.area ?? entry.area, entry.area);
    const max = Math.max(row[0]?.area ?? entry.area, entry.area);
    const ratio = Math.max(side ** 2 * max / area ** 2, area ** 2 / (side ** 2 * min));
    if (row.length && ratio > worst) {
      placeRow();
      worst = Math.max(Math.min(width, height) ** 2 / entry.area,
        entry.area / Math.min(width, height) ** 2);
    } else {
      worst = ratio;
    }
    row.push(entry);
    sum += entry.area;
  }
  if (row.length) placeRow();
  return tiles;
}

export function makeTreemap(canvas, label, formatSize, activate, highlight) {
  const ctx = canvas.getContext("2d");
  let items = [];
  let tiles = [];
  let active = null;

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--map-bg").trim() || "#171d1e";
    ctx.fillRect(0, 0, width, height);
    tiles = items.length ? layout(items, width, height) : [];
    ctx.font = "500 11px Segoe UI, system-ui, sans-serif";
    tiles.forEach((tile, index) => {
      const { item, x, y, width: w, height: h } = tile;
      if (w < 1 || h < 1) return;
      ctx.fillStyle = item.id === 0 ? "#34423e" : palette[index % palette.length];
      ctx.beginPath();
      ctx.roundRect(x + 2, y + 2, Math.max(0, w - 4), Math.max(0, h - 4), Math.min(5, w / 4, h / 4));
      ctx.fill();
      if (tile.item === active) {
        ctx.strokeStyle = "#c8f8e1";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (w < 42 || h < 25) return;
      ctx.fillStyle = "#f1f7f3";
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 6, y + 4, w - 12, h - 8);
      ctx.clip();
      let title = item.name;
      while (title.length > 1 && ctx.measureText(title).width > w - 20) title = title.slice(0, -2) + "…";
      ctx.fillText(title, x + 9, y + 21);
      if (h >= 46) {
        ctx.font = "400 10px Segoe UI, system-ui, sans-serif";
        ctx.fillStyle = "#d4e4db";
        ctx.fillText(formatSize(item.size), x + 9, y + 38);
        ctx.font = "500 11px Segoe UI, system-ui, sans-serif";
      }
      ctx.restore();
    });
  }

  function locate(event) {
    return tiles.find(({ x, y, width, height }) =>
      event.offsetX >= x && event.offsetX < x + width
      && event.offsetY >= y && event.offsetY < y + height)?.item ?? null;
  }

  function update(item) {
    if (active === item) return;
    active = item;
    canvas.classList.toggle("interactive", Boolean(item?.id));
    label.textContent = item ? item.name + " · " + formatSize(item.size) : "Survolez un bloc pour voir son détail.";
    canvas.title = item ? item.name + " · " + formatSize(item.size) : "";
    highlight(item?.id);
    draw();
  }

  canvas.addEventListener("pointermove", event => update(locate(event)));
  canvas.addEventListener("pointerleave", () => update(null));
  canvas.addEventListener("click", event => {
    const item = locate(event);
    if (item?.id) activate(item);
  });
  new ResizeObserver(draw).observe(canvas);
  document.addEventListener("themechange", draw);

  return (rows, other) => {
    items = [...rows, ...(other > 0 ? [{ id: 0, name: "Autres éléments", size: other }] : [])]
      .filter(item => Number.isFinite(item.size) && item.size > 0);
    items.sort((a, b) => b.size - a.size);
    active = null;
    canvas.classList.remove("interactive");
    label.textContent = "Survolez un bloc pour voir son détail.";
    canvas.title = "";
    draw();
  };
}

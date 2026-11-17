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

const palette = [
  ['#7651c3', '#5265c4'],
  ['#4e67c6', '#356cb9'],
  ['#8b55b6', '#7057bb'],
  ['#4457a5', '#4e76bc'],
  ['#6254a9', '#5671bf'],
  ['#685cb5', '#4d67aa'],
];

export function makeTreemap(canvas, label, formatSize, activate, highlight) {
  const context = canvas.getContext('2d');
  let items = [];
  let tiles = [];
  let active = null;

  function fitText(text, width) {
    const characters = Array.from(text);
    while (characters.length > 1 && context.measureText(characters.join('')).width > width) {
      characters.splice(-2, 2, '…');
    }
    return characters.join('');
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    tiles = layout(items, width, height);
    for (const [index, tile] of tiles.entries()) {
      const { item, x, y, width: w, height: h } = tile;
      if (w <= 4 || h <= 4) continue;
      const colors = palette[index % palette.length];
      const gradient = context.createLinearGradient(x, y, x + w, y + h);
      gradient.addColorStop(0, item.id === 0 ? '#626e85' : colors[0]);
      gradient.addColorStop(1, item.id === 0 ? '#515e75' : colors[1]);
      context.fillStyle = gradient;
      context.beginPath();
      context.roundRect(x + 2, y + 2, w - 4, h - 4, Math.min(9, w / 5, h / 5));
      context.fill();
      if (active === item) {
        context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        context.lineWidth = 2;
        context.stroke();
      }
      if (w < 76 || h < 40) continue;
      context.save();
      context.beginPath();
      context.rect(x + 10, y + 8, w - 20, h - 16);
      context.clip();
      context.fillStyle = '#ffffff';
      context.font = '650 14px Manrope, sans-serif';
      context.fillText(fitText(item.name, w - 26), x + 13, y + 26);
      if (h >= 64) {
        context.font = '450 13px Manrope, sans-serif';
        context.fillText(formatSize(item.size), x + 13, y + 48);
      }
      context.restore();
    }
  }

  function locate(event) {
    return tiles.find(({ x, y, width, height }) =>
      event.offsetX >= x && event.offsetX < x + width && event.offsetY >= y && event.offsetY < y + height
    )?.item ?? null;
  }

  function update(item) {
    if (active === item) return;
    active = item;
    canvas.classList.toggle('interactive', Boolean(item?.id));
    label.textContent = item ? item.name + ' · ' + formatSize(item.size) : 'Click a folder to open it. Hover over a block to see its size.';
    canvas.title = item ? item.name + ' · ' + formatSize(item.size) : '';
    highlight(item?.id);
    draw();
  }

  canvas.addEventListener('pointermove', event => update(locate(event)));
  canvas.addEventListener('pointerleave', () => update(null));
  canvas.addEventListener('click', event => {
    const item = locate(event);
    if (item?.id) activate(item);
  });
  new ResizeObserver(draw).observe(canvas);
  canvas.closest('details')?.addEventListener('toggle', draw);
  document.addEventListener('themechange', draw);
  document.fonts?.ready.then(draw);

  return (rows, other) => {
    items = [...rows, ...(other > 0 ? [{ id: 0, name: 'Other items', size: other }] : [])]
      .filter(item => Number.isFinite(item.size) && item.size > 0)
      .sort((a, b) => b.size - a.size);
    active = null;
    canvas.classList.remove('interactive');
    canvas.title = '';
    label.textContent = 'Click a folder to open it. Hover over a block to see its size.';
    draw();
  };
}
